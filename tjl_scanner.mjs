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
import { spawnSync } from 'node:child_process';

const CHART = "window.TradingViewApi._activeChartWidgetWV.value()";
const BARS  = "window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()";

const args = process.argv.slice(2);
const NO_GATE = args.includes('--no-gate');
const SCHEDULED = args.includes('--scheduled');   // enables once-per-day marker
const TICKERS = args.filter(a => !a.startsWith('--'));
const UNIVERSE_CSV = process.env.TJL_UNIVERSE_CSV || './pluang_us_stocks.csv';
const TOP_N = parseInt(process.env.TJL_TOP_N || '500', 10);   // 0 = all; default top 500 by mkt cap
let UNIVERSE_SRC = 'args';
let UNIVERSE = TICKERS;
if (!UNIVERSE.length) {
  const fromCsv = loadUniverseFromCsv(UNIVERSE_CSV);   // CSV is ordered by market cap (largest first)
  if (fromCsv && fromCsv.length) {
    UNIVERSE = TOP_N > 0 ? fromCsv.slice(0, TOP_N) : fromCsv;
    UNIVERSE_SRC = `Pluang top-${TOP_N > 0 ? TOP_N : 'all'} by mkt cap`;
  } else { UNIVERSE = ['AMD', 'NVDA', 'MU']; UNIVERSE_SRC = 'fallback'; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// minimal CSV parse (handles quoted fields with embedded commas, e.g. "Robinhood, Inc.")
function parseCsv(text) {
  const rows = []; let row = [], field = '', inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inq = false; } else field += c; }
    else if (c === '"') inq = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function loadUniverseFromCsv(path) {
  try {
    const rows = parseCsv(readFileSync(path, 'utf8'));
    if (rows.length < 2) return null;
    const head = rows[0].map(h => h.trim().toLowerCase());
    const si = head.indexOf('symbol'), ei = head.indexOf('is_trading_enabled');
    if (si < 0) return null;
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const sym = (rows[r][si] || '').trim().toUpperCase();
      const en = ei >= 0 ? (rows[r][ei] || 'TRUE').trim().toUpperCase() : 'TRUE';
      if (sym && en !== 'FALSE') out.push(sym);
    }
    return out;
  } catch { return null; }
}

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
  // prev_daily_* must be the PREVIOUS COMPLETED daily bar, NOT today's still-forming
  // bar (during RTH the last bar is today, whose high the live price can't exceed).
  return evaluate(`(function(){
    var bars=${BARS};
    if(!bars||typeof bars.lastIndex!=='function') return null;
    function etd(t){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t*1000));}
    var today=etd(Date.now()/1000), end=bars.lastIndex(), fi=bars.firstIndex();
    var pi=end;
    while(pi>=fi && etd(bars.valueAt(pi)[0])>=today) pi--;   // skip today's forming bar(s)
    if(pi<fi) return null;
    var prev=bars.valueAt(pi);
    var s=Math.max(fi, pi-199), closes=[];
    for(var i=s;i<=pi;i++){var v=bars.valueAt(i); if(v) closes.push(v[4]);}
    var sma=closes.reduce(function(a,b){return a+b;},0)/closes.length;
    return {prev_daily_high:prev[2], prev_daily_close:prev[4], sma200:Math.round(sma*100)/100, n_closes:closes.length, prev_date:etd(prev[0])};
  })()`);
}

async function intradayMetrics() {
  return evaluate(`(function(){
    var bars=${BARS};
    if(!bars||typeof bars.lastIndex!=='function') return null;
    var end=bars.lastIndex(), start=Math.max(bars.firstIndex(), end-399), arr=[];
    for(var i=start;i<=end;i++){var v=bars.valueAt(i); if(v) arr.push([v[0],v[2],v[3],v[4],v[5]]);} // time,high,low,close,vol
    if(!arr.length) return null;
    function et(t){var p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(t*1000));var o={};p.forEach(function(x){o[x.type]=x.value;});var h=o.hour==='24'?0:parseInt(o.hour,10);return {ymd:o.year+'-'+o.month+'-'+o.day,mins:h*60+parseInt(o.minute,10)};}
    var nowT=arr[arr.length-1][0], nowET=et(nowT), today=nowET.ymd, pmh=null, hod=null, vN=0, vD=0;
    for(var j=0;j<arr.length;j++){
      var t=arr[j][0],hi=arr[j][1],lo=arr[j][2],cl=arr[j][3],vol=arr[j][4]||0; var e=et(t); if(e.ymd!==today) continue;
      if(e.mins>=240&&e.mins<570){ if(t!==nowT && (pmh===null||hi>pmh)) pmh=hi; }            // premarket high
      else if(e.mins>=570){ if(t!==nowT && (hod===null||hi>hod)) hod=hi; vN+=((hi+lo+cl)/3)*vol; vD+=vol; } // RTH: HOD + session VWAP
    }
    var vwap = vD>0 ? Math.round(vN/vD*100)/100 : null;
    return {pmh:pmh, today_hod:hod, vwap:vwap, curr_px:arr[arr.length-1][3], now_mins_et:nowET.mins, today_et:today};
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

// Why-long catalyst for a PASS ticker, via `claude -p` WebFetch (Benzinga; reliable
// vs Yahoo /news which 503s). Best-effort: returns nulls on any failure.
function fetchCatalyst(ticker) {
  const claudeCmd = process.env.CLAUDE_BIN || (process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude.cmd` : 'claude');
  const prompt = `Use the WebFetch tool on https://www.benzinga.com/quote/${ticker} . In ONE sentence, what recent news or catalyst supports going LONG ${ticker} today? Then up to 2 recent headlines verbatim. Just the data, no commentary. Output ONLY compact JSON, no markdown fences: {"reason":"<one sentence or null>","headlines":["<verbatim>"],"source":"benzinga"}`;
  try {
    const r = spawnSync(claudeCmd, ['-p', '--allowedTools', 'WebFetch', '--output-format', 'text'],
      { input: prompt, encoding: 'utf8', timeout: 120000, shell: true });
    const m = (r.stdout || '').match(/\{[\s\S]*\}/);
    if (m) { const o = JSON.parse(m[0]); return { reason: o.reason || null, headlines: Array.isArray(o.headlines) ? o.headlines.slice(0, 2).map(String) : [], source: o.source || 'benzinga' }; }
  } catch { /* best-effort */ }
  return { reason: null, headlines: [], source: null };
}

function resolveWebhook() {
  if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL.trim();
  try { return readFileSync('./.slack_webhook', 'utf8').trim() || null; } catch { return null; }
}

function renderTjl(doc) {
  if (doc.status === 'skipped') return `:no_entry: *Pluang Research Long Scanner — skipped*\n${doc.reason}`;
  const hits = doc.hits || [];
  const counts = {}; for (const r of (doc.all_results || [])) counts[r.result] = (counts[r.result] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no results';
  const lines = [
    `:dart: *Pluang Research Long Scanner* — ${doc.candidates_checked} Pluang tickers${/bypassed/.test(doc.note || '') ? ' _(test, gate bypassed)_' : ''}`,
    `_${summary}${doc.scan_span_min != null ? ` · scan ~${doc.scan_span_min}m` : ''}_`,
    '',
  ];
  if (!hits.length) { lines.push('*No long setups passed the filters today.*'); return lines.join('\n'); }
  lines.push(`*:white_check_mark: LONG candidates (${hits.length}):*`);
  const MAX = 30;   // cap the webhook message (very long messages get dropped by Slack)
  for (const h of hits.slice(0, MAX)) {
    const why = h.long_reason ? ` — ${String(h.long_reason).slice(0, 130)}${h.source ? ` _(${h.source})_` : ''}` : '';
    lines.push(`*${h.symbol}* $${h.curr_price} _(>${h.prev_daily_high} hi · >VWAP ${h.vwap})_${why}`);
    if (h.plan && h.plan.stop != null) lines.push(`   :dart: stop *${h.plan.stop}* (support OB) · target *${h.plan.target}* _(${h.plan.target_basis})_ · R:R *${h.plan.rr}*`);
  }
  if (hits.length > MAX) lines.push(`_…and ${hits.length - MAX} more — full list in the saved JSON._`);
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

// Read 15-min Order Block / Breaker Block zones (LuxAlgo) for the loaded symbol.
const OB_ZONES_JS = `(function(){
  var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
  var sources=chart.model().model().dataSources(); var zones=[];
  for(var si=0;si<sources.length;si++){var s=sources[si];
    try{ if(!s.metaInfo) continue; var m=s.metaInfo(); var name=m.description||m.shortDescription||'';
      if(name.indexOf('Order Block')===-1 && name.indexOf('Breaker')===-1) continue;
      var g=s._graphics; if(!g||!g._primitivesCollection) continue;
      var outer=g._primitivesCollection.dwgboxes; if(!outer) continue;
      var inner=outer.get('boxes'); if(!inner) continue; var coll=inner.get(false);
      if(coll&&coll._primitivesDataById){ coll._primitivesDataById.forEach(function(v){ if(v.y1!=null&&v.y2!=null){ zones.push({high:Math.max(v.y1,v.y2), low:Math.min(v.y1,v.y2)}); } }); }
    }catch(e){}
  }
  return zones;
})()`;

// Build a long trading plan: stop = below nearest support OB; target = nearest
// resistance OB above, else a 2R measured move (breakouts at highs have no OB above).
function computePlan(entry, zones) {
  const uniq = [], seen = new Set();
  for (const z of (zones || [])) { const k = z.high + ':' + z.low; if (!seen.has(k)) { seen.add(k); uniq.push(z); } }
  const below = uniq.filter(z => z.high < entry).sort((a, b) => b.high - a.high);
  const above = uniq.filter(z => z.low > entry).sort((a, b) => a.low - b.low);
  const support = below[0] || null, resistance = above[0] || null;
  const r2 = x => Math.round(x * 100) / 100;
  const stop = support ? r2(support.low) : null;
  const risk = stop != null ? r2(entry - stop) : null;
  let target = null, basis = 'n/a';
  if (resistance) { target = r2(resistance.low); basis = `OB resistance ${r2(resistance.low)}-${r2(resistance.high)}`; }
  else if (risk != null && risk > 0) { target = r2(entry + 2 * risk); basis = '2R measured (no overhead OB)'; }
  const rr = (risk && risk > 0 && target != null) ? r2((target - entry) / risk) : null;
  return { stop, target, rr, risk, support_zone: support, resistance_zone: resistance, target_basis: basis, n_zones: uniq.length };
}

async function obPlan(entry) {
  await setTf('15');
  await sleep(1300);                          // let the OB/BB indicator render on 15m
  let zones = await evaluate(OB_ZONES_JS);
  if (!zones || !zones.length) { await sleep(900); zones = await evaluate(OB_ZONES_JS); }
  return computePlan(entry, zones || []);
}

async function main() {
  const ny = nyParts();

  let health = await healthCheck();
  // A freshly (re)launched TradingView opens the CDP port within ~2s but the chart API
  // (window.TradingViewApi) loads later. Wait up to ~90s for the API before giving up.
  for (let i = 0; i < 30 && health.cdp_connected && !health.api_available; i++) {
    await new Promise(r => setTimeout(r, 3000));
    health = await healthCheck();
  }
  if (!health.cdp_connected || !health.api_available) {
    console.error('TradingView not reachable on CDP 9222 (cdp=%s api=%s).', health.cdp_connected, health.api_available);
    console.error('Launch it (Windows / this machine):');
    console.error('  Get-Process TradingView -EA SilentlyContinue | Stop-Process -Force');
    console.error('  Start-Process "C:\\\\Program Files\\\\WindowsApps\\\\TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj\\\\TradingView.exe" -ArgumentList "--remote-debugging-port=9222"');
    await disconnect(); process.exit(2);
  }

  const hourET = Math.floor(ny.mins / 60);
  const marker = `./.tjl_done_${ny.ymd}_${String(hourET).padStart(2, '0')}`;  // once-per-HOUR guard (hourly schedule)
  if (SCHEDULED && existsSync(marker)) {
    console.error('TJL: already ran this hour (%s %02d:00 ET) — skipping', ny.ymd, hourET);
    await disconnect(); process.exit(0);
  }

  const inWindow = ny.mins >= 600 && ny.mins <= 960; // 10:00-16:00 ET (open..close)
  const isWeekday = !['Sat', 'Sun'].includes(ny.wd);
  if (!NO_GATE && (!inWindow || !isWeekday)) {
    return saveExit({
      scanned_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      status: 'skipped', error: 'outside_trading_window',
      reason: `NY ${ny.hhmm} ET (${ny.wd}) is outside the 10:00-16:00 ET weekday window; scan not run. Use --no-gate to override.`,
      candidates_checked: 0, hits: [], all_results: [],
    }, outName(ny));
  }

  console.error(`scanning ${UNIVERSE.length} tickers (${UNIVERSE_SRC}) — sequential, expect ~${Math.round(UNIVERSE.length * 5 / 60)} min`);
  const metrics = {};
  const all_results = [];
  const name = outName(ny);
  const scanStart = new Date();
  let done = 0;
  for (const sym of UNIVERSE) {                 // sequential by design
    done++;
    process.stderr.write(`[${done}/${UNIVERSE.length}] ${sym} ...\n`);
    try {
      await setSymbol(sym);
      await setTf('D');
      const d = await dailyMetrics();
      await setTf('1');
      await enableExtendedHours();
      const it = await intradayMetrics();
      if (!d || !it) { metrics[sym] = { error: 'data_unavailable' }; all_results.push({ symbol: sym, result: 'error' }); }
      else {
        const curr = it.curr_px;
        const daily_bo = curr > d.prev_daily_high && d.prev_daily_close > d.sma200;
        // intraday_breakout = (curr > premarket high) AND (curr > VWAP)
        const intraday_bo = curr > it.pmh && it.vwap != null && curr > it.vwap;
        const result = (daily_bo && intraday_bo) ? 'PASS' : (!daily_bo ? 'fail_daily' : 'fail_intraday');
        metrics[sym] = {
          curr_price: curr, prev_daily_high: d.prev_daily_high, prev_daily_close: d.prev_daily_close,
          sma200: d.sma200, pmh: it.pmh, vwap: it.vwap, today_hod: it.today_hod, daily_breakout: daily_bo, intraday_breakout: intraday_bo,
        };
        all_results.push({ symbol: sym, result });
        if (result === 'PASS') process.stderr.write(`  >>> PASS ${sym} @ ${curr}\n`);
      }
    } catch (e) {                               // one bad ticker must not abort the whole run
      process.stderr.write(`  ! ${sym} error: ${String(e.message || e).slice(0, 80)}\n`);
      metrics[sym] = { error: 'exception' };
      all_results.push({ symbol: sym, result: 'error' });
    }
    if (done % 25 === 0) {                       // checkpoint partial progress
      try {
        writeFileSync(name, JSON.stringify({
          scanned_at: scanStart.toISOString().replace(/\.\d+Z$/, 'Z'), status: 'in_progress',
          progress: `${done}/${UNIVERSE.length}`, candidates_checked: done, hits: [], all_results, metrics,
        }, null, 2));
      } catch {}
    }
  }
  const spanMin = Math.round((new Date() - scanStart) / 60000);

  // PASS = long candidates -> fetch the long thesis / catalyst (Benzinga via claude -p)
  const passSyms = all_results.filter(r => r.result === 'PASS').map(r => r.symbol);
  const catalysts = {}, plans = {};
  for (const sym of passSyms) {
    process.stderr.write(`enrich PASS: ${sym} (catalyst + OB plan) ...\n`);
    catalysts[sym] = fetchCatalyst(sym);                                  // claude -p (no chart)
    try { await setSymbol(sym); plans[sym] = await obPlan(metrics[sym].curr_price); } // 15m OB/BB plan
    catch (e) { plans[sym] = null; process.stderr.write(`  ! ${sym} plan error: ${String(e.message || e).slice(0, 60)}\n`); }
  }

  const hits = passSyms.map(sym => ({
    symbol: sym, curr_price: metrics[sym].curr_price, prev_daily_high: metrics[sym].prev_daily_high,
    sma200: metrics[sym].sma200, pmh: metrics[sym].pmh, vwap: metrics[sym].vwap, today_hod: metrics[sym].today_hod,
    long_reason: catalysts[sym].reason, headlines: catalysts[sym].headlines, source: catalysts[sym].source,
    plan: plans[sym] || null,
  }));

  const doc = {
    scanned_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    universe: UNIVERSE_SRC, candidates_checked: UNIVERSE.length, scan_span_min: spanMin,
    hits, all_results,
    note: `Brute-force scan of ${UNIVERSE.length} Pluang tickers over ~${spanMin} min${NO_GATE ? ' (gate bypassed)' : ''}; curr_price = live 1-min price (note: prices drift across a multi-minute scan).`,
    metrics,
  };
  writeFileSync(name, JSON.stringify(doc, null, 2));
  console.log('wrote', name);
  const counts = {}; for (const r of all_results) counts[r.result] = (counts[r.result] || 0) + 1;
  console.log(`Pluang Research Long Scanner: ${UNIVERSE.length} checked over ~${spanMin}m — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  for (const h of hits) console.log(`PASS ${h.symbol} @ ${h.curr_price} — ${h.long_reason || '(no catalyst)'}`);
  await postWebhook(renderTjl(doc));
  if (SCHEDULED) { try { writeFileSync(marker, new Date().toISOString()); } catch {} }  // mark done for today
  await disconnect();
}

main().catch(async e => { console.error('FATAL:', e.message || e); try { await disconnect(); } catch {} process.exit(1); });
