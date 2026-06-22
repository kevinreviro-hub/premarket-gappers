#!/usr/bin/env node
// bow_scanner.mjs — Pluang Research Buy on Weakness (BOW) Scanner.
// Daily/EOD mean-reversion-in-uptrend scan over the Pluang top-N universe, using free
// Yahoo daily data (no TradingView chart, no MCP). Sibling to tjl_scanner.mjs; posts to
// the same Slack channel via the shared webhook. Strategy locked from bow_optimize.mjs:
//
//   ENTRY (today's daily bar): close > SMA200  AND  SMA200 rising (> value 20 bars ago)
//                              AND  RSI(2) < 5   (sharp pullback inside an uptrend)
//   PLAN:  buy at close · target +25% · stop -15% · time-stop ~60 trading days
//   Backtest (top-500, 3y, net of 0.4% commission): WR 50.8% · PF 1.36 · avg +2.0%/trade · +$52k
//
// Usage:
//   node bow_scanner.mjs                 # scan now + post to Slack
//   node bow_scanner.mjs --scheduled     # once-per-US-day marker (.bow_done_<ET-date>)
//   node bow_scanner.mjs --no-catalyst   # skip Benzinga enrichment (fast test)
//   node bow_scanner.mjs --no-slack      # don't post (local JSON only)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const SCHEDULED = args.includes('--scheduled');
const NO_CATALYST = args.includes('--no-catalyst') || process.env.NO_CATALYST === '1';
const NO_SLACK = args.includes('--no-slack') || process.env.NO_SLACK === '1';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE = process.env.RANGE || '2y';
const SMA_LEN = 200, RISING_LB = 20, RSI_THR = 5, TP = 0.25, SL = 0.15, HOLD = 60;
const MAX_CATALYST = 15, MAX_POST = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function loadSymbols() {
  const rows = parseCsv(readFileSync('./pluang_us_stocks.csv', 'utf8'));
  const head = rows[0].map(h => h.trim().toLowerCase());
  const si = head.indexOf('symbol'), ei = head.indexOf('is_trading_enabled');
  const out = [];
  for (let r = 1; r < rows.length && out.length < TOP_N; r++) {
    const sym = (rows[r][si] || '').trim().toUpperCase();
    const en = ei >= 0 ? (rows[r][ei] || 'TRUE').trim().toUpperCase() : 'TRUE';
    if (sym && en !== 'FALSE') out.push(sym);
  }
  return out;
}
async function fetchDaily(sym, tries = 2) {
  const ysym = sym.replace(/\./g, '-');
  const host = tries % 2 ? 'query1' : 'query2';
  const u = `https://${host}.finance.yahoo.com/v8/finance/chart/${ysym}?range=${RANGE}&interval=1d`;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) throw new Error('no data');
    const q = res.indicators.quote[0], bars = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      bars.push({ t: res.timestamp[i], c: q.close[i] });
    }
    return bars;
  } catch (e) { if (tries > 1) { await sleep(500); return fetchDaily(sym, tries - 1); } throw e; }
}
const smaArr = (a, n) => { const o = Array(a.length).fill(null); let r = 0; for (let i = 0; i < a.length; i++) { r += a[i]; if (i >= n) r -= a[i - n]; if (i >= n - 1) o[i] = r / n; } return o; };
function rsiArr(c, n) { const o = Array(c.length).fill(null); let ag = 0, al = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0; if (i <= n) { ag += g; al += l; if (i === n) { ag /= n; al /= n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } return o; }
const etDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// Benzinga "why buy" catalyst via `claude -p` WebFetch (mirrors tjl_scanner). Best-effort.
function fetchCatalyst(ticker) {
  const claudeCmd = process.env.CLAUDE_BIN || (process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude.cmd` : 'claude');
  const prompt = `Use the WebFetch tool on https://www.benzinga.com/quote/${ticker} . ${ticker} just pulled back sharply but is still in an uptrend. In ONE sentence, is the weakness just a dip (buyable) or real bad news (avoid)? Then up to 2 recent headlines verbatim. Output ONLY compact JSON, no markdown fences: {"reason":"<one sentence or null>","headlines":["<verbatim>"],"source":"benzinga"}`;
  try {
    const r = spawnSync(claudeCmd, ['-p', '--allowedTools', 'WebFetch', '--output-format', 'text'], { input: prompt, encoding: 'utf8', timeout: 120000, shell: true });
    const m = (r.stdout || '').match(/\{[\s\S]*\}/);
    if (m) { const o = JSON.parse(m[0]); return { reason: o.reason || null, headlines: Array.isArray(o.headlines) ? o.headlines.slice(0, 2).map(String) : [], source: o.source || 'benzinga' }; }
  } catch { /* best-effort */ }
  return { reason: null, headlines: [], source: null };
}
function resolveWebhook() {
  if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL.trim();
  try { return readFileSync('./.slack_webhook', 'utf8').trim() || null; } catch { return null; }
}
async function postWebhook(text) {
  const url = resolveWebhook();
  if (!url) { console.error('slack: no webhook (.slack_webhook / SLACK_WEBHOOK_URL) — skipped'); return false; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = (await res.text()).trim();
    if (res.ok && body === 'ok') { console.error('slack: posted to webhook'); return true; }
    console.error('slack: webhook post failed (%s %s)', res.status, body.slice(0, 80)); return false;
  } catch (e) { console.error('slack: webhook error', e.message); return false; }
}
function render(doc) {
  const hits = doc.hits;
  const lines = [
    `:ocean: *Pluang Research Buy on Weakness (BOW) Scanner* — ${doc.scanned} Pluang tickers · ${doc.asof}`,
    `_RSI(2)<${RSI_THR} dip in a rising 200-SMA uptrend · plan: target +${TP*100}% / stop -${SL*100}% / ~${HOLD}d_`,
    '',
  ];
  if (!hits.length) { lines.push('*No buy-on-weakness setups today.*'); return lines.join('\n'); }
  lines.push(`*:large_blue_circle: BOW candidates (${hits.length}):*`);
  for (const h of hits.slice(0, MAX_POST)) {
    const why = h.reason ? ` — ${String(h.reason).slice(0, 130)}${h.source ? ` _(${h.source})_` : ''}` : '';
    lines.push(`*${h.symbol}* $${h.close} _(today ${h.dayChg >= 0 ? '+' : ''}${h.dayChg}% · RSI2 ${h.rsi2})_${why}`);
    lines.push(`   :dart: entry *$${h.close}* · target *$${h.target}* (+${TP*100}%) · stop *$${h.stop}* (-${SL*100}%) · R:R *${h.rr}*`);
  }
  if (hits.length > MAX_POST) lines.push(`_…and ${hits.length - MAX_POST} more — see saved JSON._`);
  return lines.join('\n');
}

async function main() {
  const asof = etDate();
  const etWd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
  if (SCHEDULED && (etWd === 'Sat' || etWd === 'Sun')) { console.error(`weekend (${etWd} ET) — skip, no fresh US session`); return; }
  if (SCHEDULED) { const marker = `./.bow_done_${asof}`; if (existsSync(marker)) { console.error(`already ran for ${asof} — skip`); return; } }
  const syms = loadSymbols();
  console.error(`BOW scan: ${syms.length} tickers, asof ${asof} (ET)`);
  const hits = []; let ok = 0, err = 0;
  for (let n = 0; n < syms.length; n++) {
    const sym = syms[n];
    try {
      const bars = await fetchDaily(sym);
      if (bars.length < SMA_LEN + RISING_LB + 2) { err++; await sleep(105); continue; }
      const c = bars.map(b => b.c), sma200 = smaArr(c, 200), rsi2 = rsiArr(c, 2);
      const i = bars.length - 1;                                   // today's (latest) bar
      const rising = sma200[i - RISING_LB] != null && sma200[i] > sma200[i - RISING_LB];
      if (sma200[i] != null && c[i] > sma200[i] && rising && rsi2[i] != null && rsi2[i] < RSI_THR) {
        const close = c[i], dayChg = +((c[i] / c[i - 1] - 1) * 100).toFixed(2);
        hits.push({ symbol: sym, close: +close.toFixed(2), rsi2: +rsi2[i].toFixed(1), dayChg,
          target: +(close * (1 + TP)).toFixed(2), stop: +(close * (1 - SL)).toFixed(2), rr: +(TP / SL).toFixed(2) });
      }
      ok++;
    } catch { err++; }
    if ((n + 1) % 100 === 0) console.error(`  ${n + 1}/${syms.length} (ok ${ok}, err ${err}, hits ${hits.length})`);
    await sleep(105);
  }
  hits.sort((a, b) => a.dayChg - b.dayChg);                       // deepest weakness first
  if (!NO_CATALYST) {
    for (const h of hits.slice(0, MAX_CATALYST)) { process.stderr.write(`catalyst: ${h.symbol} ...\n`); const cat = fetchCatalyst(h.symbol); h.reason = cat.reason; h.headlines = cat.headlines; h.source = cat.source; }
  }
  const doc = { strategy: 'BOW', asof, scanned: ok, errors: err, params: { rsi2_lt: RSI_THR, target_pct: TP * 100, stop_pct: SL * 100, hold_days: HOLD }, hits };
  const name = `./bow_watchlist_${asof}.json`;
  writeFileSync(name, JSON.stringify(doc, null, 2));
  console.log(`wrote ${name} — ${hits.length} BOW candidates`);
  for (const h of hits) console.log(`  ${h.symbol} $${h.close} (RSI2 ${h.rsi2}, ${h.dayChg}%)${h.reason ? ' — ' + h.reason : ''}`);
  if (!NO_SLACK) await postWebhook(render(doc));
  if (SCHEDULED) { try { writeFileSync(`./.bow_done_${asof}`, new Date().toISOString()); } catch {} }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
