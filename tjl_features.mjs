#!/usr/bin/env node
// tjl_features.mjs — extract every TJL entry signal (top-N, last YEARS) with a battery
// of candidate filter features computed AT ENTRY, plus the trade outcome. Writes
// tjl_trades.json for offline filter research (tjl_analyze.mjs). Refetches Yahoo daily
// + SPY (for market regime / relative strength). No commission modeled.
import { readFileSync, writeFileSync } from 'node:fs';

const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE = process.env.RANGE || '5y', YEARS = parseFloat(process.env.YEARS || '3');
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
      bars.push({ t: res.timestamp[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? null });
    }
    return bars;
  } catch (e) { if (tries > 1) { await sleep(500); return fetchDaily(sym, tries - 1); } throw e; }
}
// ---- indicators (arrays aligned to bars) ----
const smaArr = (a, n) => { const o = Array(a.length).fill(null); let r = 0; for (let i = 0; i < a.length; i++) { r += a[i]; if (i >= n) r -= a[i - n]; if (i >= n - 1) o[i] = r / n; } return o; };
function rsiArr(c, n) { const o = Array(c.length).fill(null); let ag = 0, al = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0; if (i <= n) { ag += g; al += l; if (i === n) { ag /= n; al /= n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } return o; }
function atrArr(h, l, c, n) { const len = c.length, tr = Array(len).fill(null); for (let i = 0; i < len; i++) tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); const o = Array(len).fill(null); let prev = null; for (let i = 0; i < len; i++) { if (i < n) { if (i === n - 1) { let s = 0; for (let k = 0; k < n; k++) s += tr[k]; prev = s / n; o[i] = prev; } } else { prev = (prev * (n - 1) + tr[i]) / n; o[i] = prev; } } return o; }
function adxArr(h, l, c, n) { const len = c.length, pdm = Array(len).fill(0), ndm = Array(len).fill(0), tr = Array(len).fill(0);
  for (let i = 1; i < len; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm[i] = (up > dn && up > 0) ? up : 0; ndm[i] = (dn > up && dn > 0) ? dn : 0; tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); }
  const str = Array(len).fill(null), spdm = Array(len).fill(null), sndm = Array(len).fill(null); let t = 0, p = 0, m = 0;
  for (let i = 1; i < len; i++) { if (i <= n) { t += tr[i]; p += pdm[i]; m += ndm[i]; if (i === n) { str[i] = t; spdm[i] = p; sndm[i] = m; } } else { str[i] = str[i - 1] - str[i - 1] / n + tr[i]; spdm[i] = spdm[i - 1] - spdm[i - 1] / n + pdm[i]; sndm[i] = sndm[i - 1] - sndm[i - 1] / n + ndm[i]; } }
  const dx = Array(len).fill(null); for (let i = n; i < len; i++) if (str[i] > 0) { const pDI = 100 * spdm[i] / str[i], nDI = 100 * sndm[i] / str[i], s = pDI + nDI; dx[i] = s === 0 ? 0 : 100 * Math.abs(pDI - nDI) / s; }
  const adx = Array(len).fill(null); let a = null, cnt = 0, sum = 0; for (let i = n; i < len; i++) { if (dx[i] == null) continue; if (a == null) { sum += dx[i]; cnt++; if (cnt === n) { a = sum / n; adx[i] = a; } } else { a = (a * (n - 1) + dx[i]) / n; adx[i] = a; } } return adx; }
function emaArr(a, n) { const o = Array(a.length).fill(null), k = 2 / (n + 1); let prev = null; for (let i = 0; i < a.length; i++) { const v = a[i]; prev = prev == null ? v : v * k + prev * (1 - k); o[i] = prev; } return o; }

async function spyContext() {
  const bars = await fetchDaily('SPY'); const c = bars.map(b => b.c), s200 = smaArr(c, SMA_LEN);
  const map = {};
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].t * 1000).toISOString().slice(0, 10);
    map[d] = { above200: s200[i] != null ? c[i] > s200[i] : null, ret20: i >= 20 ? c[i] / c[i - 20] - 1 : null };
  }
  return map;
}

const syms = loadSymbols();
const cutoff = Math.floor(Date.now() / 1000) - Math.round(YEARS * 365.25 * 86400);
console.error(`extracting TJL signals+features: ${syms.length} symbols, last ${YEARS}y`);
const spy = await spyContext();
const trades = []; let ok = 0, err = 0;
for (let n = 0; n < syms.length; n++) {
  const sym = syms[n];
  try {
    const bars = await fetchDaily(sym);
    if (bars.length < SMA_LEN + 30) { err++; await sleep(110); continue; }
    const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v);
    const sma200 = smaArr(c, 200), sma50 = smaArr(c, 50), vol20 = smaArr(v.map(x => x ?? 0), 20);
    const rsi = rsiArr(c, 14), atr = atrArr(h, l, c, 14), adx = adxArr(h, l, c, 14);
    const e12 = emaArr(c, 12), e26 = emaArr(c, 26), macd = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
    const sig = emaArr(macd.map(x => x ?? 0), 9);
    let i = SMA_LEN;
    while (i < bars.length) {
      const smaPrev = sma200[i - 1];
      if (smaPrev != null && bars[i].t >= cutoff && c[i] > h[i - 1] && c[i - 1] > smaPrev) {
        const entry = c[i], stop = entry * (1 - STOP), tgt = entry * (1 + STOP * RR);
        let exitPx = null, j = i + 1, held = 0;
        for (; j < bars.length && held < MAXHOLD; j++, held++) { if (l[j] <= stop) { exitPx = stop; break; } if (h[j] >= tgt) { exitPx = tgt; break; } }
        if (exitPx == null) exitPx = c[Math.min(j, bars.length - 1)];
        const ret = (exitPx - entry) / entry, pnl = NOTIONAL * ret;
        const d = new Date(bars[i].t * 1000).toISOString().slice(0, 10);
        const sc = spy[d] || {};
        const ret20 = i >= 20 ? c[i] / c[i - 20] - 1 : null;
        trades.push({
          sym, date: d, win: pnl > 0 ? 1 : 0, ret: +(ret * 100).toFixed(3), pnl: +pnl.toFixed(2),
          rsi: rsi[i] != null ? +rsi[i].toFixed(1) : null,
          adx: adx[i] != null ? +adx[i].toFixed(1) : null,
          volRatio: (vol20[i] && v[i] != null) ? +(v[i] / vol20[i]).toFixed(2) : null,
          distPct: sma200[i] ? +((c[i] / sma200[i] - 1) * 100).toFixed(2) : null,   // extension above 200SMA
          breakMag: +((c[i] / h[i - 1] - 1) * 100).toFixed(2),                        // how far above prev high
          atrPct: atr[i] ? +(atr[i] / c[i] * 100).toFixed(2) : null,
          cGtSma50: sma50[i] != null ? (c[i] > sma50[i] ? 1 : 0) : null,
          golden: (sma50[i] != null && sma200[i] != null) ? (sma50[i] > sma200[i] ? 1 : 0) : null,
          sma200Rising: (sma200[i] != null && sma200[i - 20] != null) ? (sma200[i] > sma200[i - 20] ? 1 : 0) : null,
          macdPos: (macd[i] != null && sig[i] != null) ? (macd[i] > sig[i] ? 1 : 0) : null,
          spyRegime: sc.above200 == null ? null : (sc.above200 ? 1 : 0),
          rs20: (ret20 != null && sc.ret20 != null) ? +((ret20 - sc.ret20) * 100).toFixed(2) : null,  // 20d RS vs SPY (pp)
        });
        i = (j < bars.length ? j : bars.length) + 1;
      } else i++;
    }
    ok++;
  } catch (e) { err++; }
  if ((n + 1) % 50 === 0) console.error(`  ${n + 1}/${syms.length} (ok ${ok}, err ${err}, trades ${trades.length})`);
  await sleep(110);
}
writeFileSync('./tjl_trades.json', JSON.stringify({ meta: { symbols_ok: ok, symbols_err: err, years: YEARS, stopPct: STOP * 100, rr: RR, maxHold: MAXHOLD }, trades }, null, 0));
const wr = trades.reduce((a, t) => a + t.win, 0) / trades.length * 100;
const gp = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
console.log(`extracted ${trades.length} trades | baseline WR ${wr.toFixed(1)}% PF ${(gp / gl).toFixed(3)} (ok ${ok}, err ${err})`);
