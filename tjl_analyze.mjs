#!/usr/bin/env node
// tjl_analyze.mjs — read tjl_trades.json and search for filter(s) that lift the TJL
// daily strategy to win rate > 60% AND profit factor > 1.3, keeping enough trades.
import { readFileSync } from 'node:fs';
const MINTR = parseInt(process.env.MINTR || '300', 10);   // min trades for a result to count
const { trades } = JSON.parse(readFileSync('./tjl_trades.json', 'utf8'));

function stat(ts) {
  const n = ts.length; if (!n) return { n: 0 };
  const w = ts.reduce((a, t) => a + t.win, 0);
  const gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = -ts.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return { n, wr: +(w / n * 100).toFixed(1), pf: gl > 0 ? +(gp / gl).toFixed(3) : Infinity,
    avg: +(ts.reduce((a, t) => a + t.ret, 0) / n).toFixed(3), pnl: +(gp - gl).toFixed(0), kept: +(n / trades.length * 100).toFixed(1) };
}
const base = stat(trades);
console.log(`BASELINE: ${base.n} trades, WR ${base.wr}%, PF ${base.pf}, avg ${base.avg}%, P&L $${base.pnl}\n`);

// ---- candidate predicates (null-safe; null => fails) ----
const P = {
  'spyRegime(SPY>200SMA)': t => t.spyRegime === 1,
  'sma200Rising': t => t.sma200Rising === 1,
  'golden(50>200)': t => t.golden === 1,
  'cGtSma50': t => t.cGtSma50 === 1,
  'macdPos': t => t.macdPos === 1,
  'ADX>=20': t => t.adx != null && t.adx >= 20,
  'ADX>=25': t => t.adx != null && t.adx >= 25,
  'ADX>=30': t => t.adx != null && t.adx >= 30,
  'RSI<=70': t => t.rsi != null && t.rsi <= 70,
  'RSI 50-70': t => t.rsi != null && t.rsi >= 50 && t.rsi <= 70,
  'RSI 55-72': t => t.rsi != null && t.rsi >= 55 && t.rsi <= 72,
  'vol>=1.5x': t => t.volRatio != null && t.volRatio >= 1.5,
  'vol>=2x': t => t.volRatio != null && t.volRatio >= 2,
  'dist<=8%': t => t.distPct != null && t.distPct <= 8,
  'dist<=12%': t => t.distPct != null && t.distPct <= 12,
  'breakMag<=2%': t => t.breakMag != null && t.breakMag <= 2,
  'rs20>=0': t => t.rs20 != null && t.rs20 >= 0,
  'rs20>=5pp': t => t.rs20 != null && t.rs20 >= 5,
  'atr%<=4': t => t.atrPct != null && t.atrPct <= 4,
};

console.log('SINGLE FILTERS (sorted by PF):');
const singles = Object.entries(P).map(([name, f]) => ({ name, ...stat(trades.filter(f)) }))
  .filter(s => s.n >= MINTR).sort((a, b) => b.pf - a.pf);
for (const s of singles) console.log(`  ${s.name.padEnd(20)} n=${String(s.n).padStart(5)} kept=${String(s.kept).padStart(4)}%  WR ${String(s.wr).padStart(4)}%  PF ${s.pf}  avg ${s.avg}%`);

// ---- combination search over a curated subset ----
const KEYS = ['spyRegime(SPY>200SMA)','sma200Rising','golden(50>200)','macdPos','ADX>=25','RSI 50-70','vol>=1.5x','dist<=12%','rs20>=0','cGtSma50'];
const preds = KEYS.map(k => [k, P[k]]);
const combos = [];
for (let mask = 1; mask < (1 << preds.length); mask++) {
  const chosen = preds.filter((_, i) => mask & (1 << i));
  const ts = trades.filter(t => chosen.every(([, f]) => f(t)));
  const s = stat(ts);
  if (s.n >= MINTR) combos.push({ keys: chosen.map(([k]) => k), size: chosen.length, ...s });
}
const hit = combos.filter(c => c.wr >= 60 && c.pf >= 1.3);
console.log(`\nCOMBINATIONS meeting WR>=60% AND PF>=1.3 (n>=${MINTR}): ${hit.length} found`);
hit.sort((a, b) => b.n - a.n);
for (const c of hit.slice(0, 15)) console.log(`  n=${String(c.n).padStart(5)} kept=${String(c.kept).padStart(4)}% WR ${c.wr}% PF ${c.pf} avg ${c.avg}% | ${c.keys.join(' + ')}`);

console.log('\nBEST PF overall (n>=' + MINTR + ', top 10):');
[...combos].sort((a, b) => b.pf - a.pf).slice(0, 10).forEach(c => console.log(`  PF ${c.pf} WR ${c.wr}% n=${c.n} | ${c.keys.join(' + ')}`));
console.log('\nBEST WR overall (n>=' + MINTR + ', top 10):');
[...combos].sort((a, b) => b.wr - a.wr).slice(0, 10).forEach(c => console.log(`  WR ${c.wr}% PF ${c.pf} n=${c.n} | ${c.keys.join(' + ')}`));
