#!/usr/bin/env node
// tjl_backtest.mjs — self-contained backtest of the TJL daily-breakout logic over
// the Pluang top-N universe, using free Yahoo daily OHLCV. No TradingView chart, no
// Pluang auth. Combines per-symbol results into portfolio stats.
//
// Entry (daily): close > previous-day high  AND  previous-day close > SMA200
//   (TJL's daily breakout + trend filter; the intraday PMH/VWAP filters can't be
//    computed on daily bars, so they're omitted — this is the daily core of TJL.)
// Exit: 5% stop OR +10% target (2R) OR 10-bar max hold. One position at a time.
// Sizing: fixed $1,000 notional per trade so $ P&L is comparable across symbols.
//
//   node tjl_backtest.mjs            # top 500
//   TOP_N=100 node tjl_backtest.mjs  # smaller
import { readFileSync, writeFileSync } from 'node:fs';

const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE = process.env.RANGE || '5y';                 // fetch 5y so SMA200 is warmed before the window
const YEARS = parseFloat(process.env.YEARS || '3');      // only ENTER trades within the last YEARS years
const STOP = 0.05, RR = 2.0, MAXHOLD = 10, NOTIONAL = 1000, SMA_LEN = 200;
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
      bars.push({ t: res.timestamp[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
    return bars;
  } catch (e) { if (tries > 1) { await sleep(500); return fetchDaily(sym, tries - 1); } throw e; }
}
function backtest(bars, cutoff) {
  const closes = bars.map(b => b.c);
  let trades = 0, wins = 0, gp = 0, gl = 0, net = 0;
  // rolling SMA200
  const sma = new Array(bars.length).fill(null);
  let run = 0;
  for (let i = 0; i < bars.length; i++) { run += closes[i]; if (i >= SMA_LEN) run -= closes[i - SMA_LEN]; if (i >= SMA_LEN - 1) sma[i] = run / SMA_LEN; }
  let i = SMA_LEN;
  while (i < bars.length) {
    const smaPrev = sma[i - 1];
    if (smaPrev != null && bars[i].t >= cutoff && bars[i].c > bars[i - 1].h && bars[i - 1].c > smaPrev) {
      const entry = bars[i].c, stop = entry * (1 - STOP), tgt = entry * (1 + STOP * RR);
      let exitPx = null, j = i + 1, held = 0;
      for (; j < bars.length && held < MAXHOLD; j++, held++) {
        if (bars[j].l <= stop) { exitPx = stop; break; }
        if (bars[j].h >= tgt) { exitPx = tgt; break; }
      }
      if (exitPx == null) exitPx = bars[Math.min(j, bars.length - 1)].c;
      const pnl = NOTIONAL * (exitPx - entry) / entry;
      trades++; net += pnl;
      if (pnl > 0) { wins++; gp += pnl; } else { gl += Math.abs(pnl); }
      i = (j < bars.length ? j : bars.length) + 1;        // resume after the exit bar
    } else i++;
  }
  return { trades, wins, gp: +gp.toFixed(2), gl: +gl.toFixed(2), net: +net.toFixed(2) };
}

const syms = loadSymbols();
const cutoff = Math.floor(Date.now() / 1000) - Math.round(YEARS * 365.25 * 86400);
console.error(`TJL daily backtest: ${syms.length} symbols, last ${YEARS}y window (fetch ${RANGE}), entry close>prevHigh & prevClose>SMA200, ${STOP*100}% stop / ${RR}R`);
const perSym = {}; let ok = 0, err = 0, tT = 0, tW = 0, tGP = 0, tGL = 0, tNet = 0;
for (let n = 0; n < syms.length; n++) {
  const sym = syms[n];
  try {
    const bars = await fetchDaily(sym);
    if (bars.length < SMA_LEN + 10) { perSym[sym] = { skip: 'bars ' + bars.length }; }
    else { const r = backtest(bars, cutoff); perSym[sym] = r; ok++; tT += r.trades; tW += r.wins; tGP += r.gp; tGL += r.gl; tNet += r.net; }
  } catch (e) { perSym[sym] = { error: String(e.message || e) }; err++; }
  if ((n + 1) % 50 === 0) console.error(`  ${n + 1}/${syms.length} (ok ${ok}, err ${err}, trades ${tT})`);
  await sleep(120);
}
const combined = {
  universe: `Pluang top-${TOP_N} via Yahoo daily, last ${YEARS}y`, symbols_ok: ok, symbols_err: err,
  total_trades: tT, win_rate_pct: tT ? +(tW / tT * 100).toFixed(1) : null,
  total_pnl_usd: +tNet.toFixed(2), gross_profit_usd: +tGP.toFixed(2), gross_loss_usd: +tGL.toFixed(2),
  profit_factor: tGL > 0 ? +(tGP / tGL).toFixed(3) : null,
  params: { entry: 'close>prevDayHigh AND prevClose>SMA200', stopPct: STOP * 100, target: RR + 'R', maxHoldBars: MAXHOLD, notionalPerTrade: NOTIONAL, windowYears: YEARS, fetchRange: RANGE },
};
writeFileSync('./tjl_backtest_combined.json', JSON.stringify({ combined, perSym }, null, 2));
console.log(JSON.stringify(combined, null, 2));
