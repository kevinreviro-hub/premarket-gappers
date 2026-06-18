#!/usr/bin/env node
// tjl_scanner.mjs — Trend Join Long entry scanner.
//
// Standalone: talks to TradingView Desktop via CDP (port 9222) by reusing this
// repo's connection layer. No interactive MCP / claude needed — run it directly:
//
//   node tjl_scanner.mjs                 # default universe AMD NVDA MU
//   node tjl_scanner.mjs AAPL MSFT TSLA  # custom universe
//   node tjl_scanner.mjs --no-gate ...   # bypass the 10:00-15:30 ET time gate (demo)
//
// PREREQ: TradingView running with --remote-debugging-port=9222.
// Per ticker (sequential): daily SMA200 + prev-day high/close, then 1-min
// premarket-high + today's HOD, then evaluate daily & intraday breakouts.
//
// FIX vs the original spec: curr_px is the LIVE 1-min price, not quote_get
// (which returns the prior-day daily close when read on the daily timeframe).

import { evaluate, disconnect } from './src/connection.js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const CHART = "window.TradingViewApi._activeChartWidgetWV.value()";
const BARS  = "window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()";

const args = process.argv.slice(2);
const NO_GATE = args.includes('--no-gate');
const SCHEDULED = args.includes('--scheduled');   // enables once-per-day marker
const TICKERS = args.filter(a => !a.startsWith('--'));
const UNIVERSE = TICKERS.length ? TICKERS : ['AMD', 'NVDA', 'MU'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function nyParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const o = {}; p.forEach(x => o[x.type] = x.value);
  const hh = o.hour === '24' ? 0 : parseInt(o.hour, 10);
  return { ymd: `${o.year}-${o.month}-${o.day}`, mins: hh * 60 + parseInt(o.minute, 10), hhmm: `${o.hour}${o.minute}`, wd: o.weekday };
}

async function waitFor(predExpr, timeoutMs = 12000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await evaluate(`!!(${predExpr})`)) return true; } catch {}
    await sleep(interval);
  }
  return false;
}

async function setSymbol(sym) {
  await evaluate(`(function(){var c=${CHART};c.setSymbol(${JSON.stringify(sym)},{});return true;})()`);
  // wait until the active symbol reflects the ticker and bars are present
  await waitFor(`(${CHART}.symbol()||'').toUpperCase().indexOf(${JSON.stringify(sym.toUpperCase())})>=0`);
}

async function setTf(tf) {
  await evaluate(`(function(){var c=${CHART};c.setResolution(${JSON.stringify(tf)},{});return true;})()`);
  await waitFor(`${BARS} && ${BARS}.lastIndex && ${BARS}.size()>0`);
  await sleep(800); // settle for the new resolution's data
}

async function enableExtendedHours() {
  await evaluate(`(function(){try{var s=window.TradingViewApi.activeChart().getSeries();var p=s.properties();p.sessionId.setValue('extended');if(p.prePostMarket)p.prePostMarket.setValue(true);return true;}catch(e){return false;}})()`);
  await sleep(900); // let premarket bars load
}

async function dailyMetrics() {
  return evaluate(`(function(){
    var bars=${BARS};
    if(!bars||typeof bars.lastIndex!=='function') return null;
    var end=bars.lastIndex(), last=bars.valueAt(end);
    var start=Math.max(bars.firstIndex(), end-199), closes=[];
    for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) closes.push(v[4]);}
    var sma=closes.reduce(function(a,b){return a+b;},0)/closes.length;
    return {prev_daily_high:last[2], prev_daily_close:last[4], sma200:Math.round(sma*100)/100, n_closes:closes.length};
  })()`);
}

async function intradayMetrics() {
  return evaluate(`(function(){
    var bars=${BARS};
    if(!bars||typeof bars.lastIndex!=='function') return null;
    var end=bars.lastIndex(), start=Math.max(bars.firstIndex(), end-399), arr=[];
    for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) arr.push([v[0],v[2],v[4]]);}
    if(!arr.length) return null;
    function et(t){var p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(t*1000));var o={};p.forEach(function(x){o[x.type]=x.value;});var h=o.hour==='24'?0:parseInt(o.hour,10);return {ymd:o.year+'-'+o.month+'-'+o.day,mins:h*60+parseInt(o.minute,10)};}
    var nowT=arr[arr.length-1][0], nowET=et(nowT), today=nowET.ymd, pmh=null, hod=null;
    for(var j=0;j<arr.length;j++){var t=arr[j][0],hi=arr[j][1]; if(t===nowT) continue; var e=et(t); if(e.ymd!==today) continue; if(e.mins>=240&&e.mins<570){if(pmh===null||hi>pmh)pmh=hi;} else if(e.mins>=570){if(hod===null||hi>hod)hod=hi;}}
    return {pmh:pmh, today_hod:hod, curr_px:arr[arr.length-1][2], now_mins_et:nowET.mins, today_et:today};
  })()`);
}

async function healthCheck() {
  try {
    const ok = await evaluate(`(function(){try{return typeof window.TradingViewApi!=='undefined' && !!${CHART} && typeof ${CHART}.setSymbol==='function';}catch(e){return false;}})()`);
    return { cdp_connected: true, api_available: !!ok };
  } catch (e) {
    return { cdp_connected: false, api_available: false, error: String(e.message || e) };
  }
}

function resolveWebhook() {
  if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL.trim();
  try { return readFileSync('./.slack_webhook', 'utf8').trim() || null; } catch { return null; }
}

function renderTjl(doc) {
  if (doc.status === 'skipped') return `:no_entry: *TJL Long Scanner — skipped*\n${doc.reason}`;
  const lines = [`:dart: *TJL Long Scanner* — ${doc.candidates_checked} checked${doc.note && /no-gate/.test(doc.note) ? '  _(test run, gate bypassed)_' : ''}`];
  const hits = doc.hits || [];
  lines.push(hits.length ? `*:white_check_mark: PASS (${hits.length}):* ${hits.map(h => h.symbol).join(', ')}` : '*No entries passed the filters.*');
  lines.push('');
  for (const r of doc.all_results) {
    const m = (doc.metrics || {})[r.symbol] || {};
    let d = '';
    if (r.result === 'fail_daily') d = `curr ${m.curr_price} ≤ prev daily high ${m.prev_daily_high}`;
    else if (r.result === 'fail_intraday') d = `daily ok, curr ${m.curr_price} ≤ ${m.today_hod == null ? 'premarket high ' + m.pmh : 'HOD'}`;
    else if (r.result === 'PASS') d = `curr ${m.curr_price} > prev high ${m.prev_daily_high} & intraday high`;
    lines.push(`${r.result === 'PASS' ? ':white_check_mark:' : '•'} *${r.symbol}* — ${r.result}${d ? ` (${d})` : ''}`);
  }
  return lines.join('\n');
}

async function postWebhook(text) {
  const url = resolveWebhook();
  if (!url) { console.error('slack: no webhook (set SLACK_WEBHOOK_URL or .slack_webhook) — skipped'); return false; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = (await res.text()).trim();
    if (res.ok && body === 'ok') { console.error('slack: posted to webhook'); return true; }
    console.error('slack: webhook post failed (%s %s)', res.status, body.slice(0, 80)); return false;
  } catch (e) { console.error('slack: webhook error', e.message); return false; }
}

function outName(ny) { return `./tjl_watchlist_${ny.ymd}_${ny.hhmm}ET.json`; }
function saveExit(doc, name, code = 0) { writeFileSync(name, JSON.stringify(doc, null, 2)); console.log('wrote', name); disconnect().finally(() => process.exit(code)); }

async function main() {
  const ny = nyParts();

  const health = await healthCheck();
  if (!health.cdp_connected || !health.api_available) {
    console.error('TradingView not reachable on CDP 9222 (cdp=%s api=%s).', health.cdp_connected, health.api_available);
    console.error('Launch it (Windows / this machine):');
    console.error('  Get-Process TradingView -EA SilentlyContinue | Stop-Process -Force');
    console.error('  Start-Process "C:\\\\Program Files\\\\WindowsApps\\\\TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj\\\\TradingView.exe" -ArgumentList "--remote-debugging-port=9222"');
    await disconnect(); process.exit(2);
  }

  const marker = `./.tjl_done_${ny.ymd}`;            // NY-dated once-per-day guard
  if (SCHEDULED && existsSync(marker)) {
    console.error('TJL: already ran today (%s ET) — skipping', ny.ymd);
    await disconnect(); process.exit(0);
  }

  const inWindow = ny.mins >= 600 && ny.mins <= 930; // 10:00-15:30 ET
  const isWeekday = !['Sat', 'Sun'].includes(ny.wd);
  if (!NO_GATE && (!inWindow || !isWeekday)) {
    return saveExit({
      scanned_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      status: 'skipped', error: 'outside_trading_window',
      reason: `NY ${ny.hhmm} ET (${ny.wd}) is outside the 10:00-15:30 ET weekday window; scan not run. Use --no-gate to override.`,
      candidates_checked: 0, hits: [], all_results: [],
    }, outName(ny));
  }

  const metrics = {};
  const all_results = [];
  for (const sym of UNIVERSE) {                 // sequential by design
    process.stderr.write(`scanning ${sym} ...\n`);
    await setSymbol(sym);
    await setTf('D');
    const d = await dailyMetrics();
    await setTf('1');
    await enableExtendedHours();
    const it = await intradayMetrics();
    if (!d || !it) { metrics[sym] = { error: 'data_unavailable' }; all_results.push({ symbol: sym, result: 'error' }); continue; }

    const curr = it.curr_px;
    const daily_bo = curr > d.prev_daily_high && d.prev_daily_close > d.sma200;
    const hod = it.today_hod == null ? -Infinity : it.today_hod;
    const intraday_bo = curr > it.pmh && curr > hod;
    const result = (daily_bo && intraday_bo) ? 'PASS' : (!daily_bo ? 'fail_daily' : 'fail_intraday');

    metrics[sym] = {
      curr_price: curr, prev_daily_high: d.prev_daily_high, prev_daily_close: d.prev_daily_close,
      sma200: d.sma200, pmh: it.pmh, today_hod: it.today_hod,
      daily_breakout: daily_bo, intraday_breakout: intraday_bo,
    };
    all_results.push({ symbol: sym, result });
  }

  const hits = all_results.filter(r => r.result === 'PASS').map(r => ({
    symbol: r.symbol, curr_price: metrics[r.symbol].curr_price, prev_daily_high: metrics[r.symbol].prev_daily_high,
    sma200: metrics[r.symbol].sma200, pmh: metrics[r.symbol].pmh, today_hod: metrics[r.symbol].today_hod,
  }));

  const doc = {
    scanned_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    candidates_checked: UNIVERSE.length,
    hits, all_results,
    note: NO_GATE ? 'Ran with --no-gate (time gate bypassed). curr_price = live 1-min price.' : 'curr_price = live 1-min price.',
    metrics,
  };
  const name = outName(ny);
  writeFileSync(name, JSON.stringify(doc, null, 2));
  console.log('wrote', name);
  for (const r of all_results) {
    const m = metrics[r.symbol];
    let reason = '';
    if (r.result === 'fail_daily') reason = `curr ${m.curr_price} <= prev daily high ${m.prev_daily_high}` + (m.prev_daily_close > m.sma200 ? ` (trend ok: ${m.prev_daily_close} > SMA200 ${m.sma200})` : ` (also below SMA200 ${m.sma200})`);
    else if (r.result === 'fail_intraday') reason = `daily breakout ok, but curr ${m.curr_price} <= ${m.today_hod == null ? 'premarket high' : 'HOD'} ${m.today_hod == null ? m.pmh : Math.max(m.pmh, m.today_hod)}`;
    else if (r.result === 'PASS') reason = `curr ${m.curr_price} > prevHigh ${m.prev_daily_high} & > intraday high; trend ${m.prev_daily_close} > SMA200 ${m.sma200}`;
    else reason = 'data unavailable';
    console.log(`${r.symbol}: ${r.result} — ${reason}`);
  }
  await postWebhook(renderTjl(doc));
  if (SCHEDULED) { try { writeFileSync(marker, new Date().toISOString()); } catch {} }  // mark done for today
  await disconnect();
}

main().catch(async e => { console.error('FATAL:', e.message || e); try { await disconnect(); } catch {} process.exit(1); });
