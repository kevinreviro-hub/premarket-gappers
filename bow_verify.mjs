#!/usr/bin/env node
// bow_verify.mjs — independent re-verification of the PRODUCTION BOW config (the exact
// rules bow_scanner.mjs uses). Detailed stats + exit-reason breakdown. Writes
// bow_verify_stats.json. Does NOT post to Slack (that's a separate, reviewed step).
import { readFileSync, writeFileSync } from 'node:fs';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE='5y',YEARS=3,SMA_LEN=200,NOTIONAL=1000,COMM=0.004;
const RSI_THR=5, RISING_LB=20, TP=0.25, SL=0.15, HOLD=60;   // production BOW (Swing TP25)
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parseCsv=t=>{const R=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===','){r.push(f);f='';}else if(c==='\n'){r.push(f);R.push(r);r=[];f='';}else if(c!=='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R;};
function loadSymbols(){const rows=parseCsv(readFileSync('./pluang_us_stocks.csv','utf8'));const head=rows[0].map(h=>h.trim().toLowerCase());const si=head.indexOf('symbol'),ei=head.indexOf('is_trading_enabled');const o=[];for(let r=1;r<rows.length&&o.length<TOP_N;r++){const s=(rows[r][si]||'').trim().toUpperCase();const e=ei>=0?(rows[r][ei]||'TRUE').trim().toUpperCase():'TRUE';if(s&&e!=='FALSE')o.push(s);}return o;}
async function fetchDaily(sym,tries=2){const y=sym.replace(/\./g,'-');const host=tries%2?'query1':'query2';const u=`https://${host}.finance.yahoo.com/v8/finance/chart/${y}?range=${RANGE}&interval=1d`;try{const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();const res=j.chart&&j.chart.result&&j.chart.result[0];if(!res||!res.timestamp)throw new Error('no data');const q=res.indicators.quote[0],b=[];for(let i=0;i<res.timestamp.length;i++){if(q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null)continue;b.push({t:res.timestamp[i],h:q.high[i],l:q.low[i],c:q.close[i]});}return b;}catch(e){if(tries>1){await sleep(500);return fetchDaily(sym,tries-1);}throw e;}}
const smaArr=(a,n)=>{const o=Array(a.length).fill(null);let r=0;for(let i=0;i<a.length;i++){r+=a[i];if(i>=n)r-=a[i-n];if(i>=n-1)o[i]=r/n;}return o;};
function rsiArr(c,n){const o=Array(c.length).fill(null);let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}

const syms=loadSymbols();
const cutoff=Math.floor(Date.now()/1000)-Math.round(YEARS*365.25*86400);
console.error(`VERIFY BOW (RSI2<${RSI_THR}, TP${TP*100}/SL${SL*100}/h${HOLD}, comm ${COMM*100}%): ${syms.length} symbols, last ${YEARS}y`);
const R=[]; let ok=0,err=0,exTgt=0,exStop=0,exTime=0;
let firstDate=null,lastDate=null;
for(let z=0;z<syms.length;z++){
  try{
    const b=await fetchDaily(syms[z]); if(b.length<SMA_LEN+RISING_LB+2){err++;await sleep(105);continue;}
    const c=b.map(x=>x.c),h=b.map(x=>x.h),l=b.map(x=>x.l);
    const sma200=smaArr(c,200),rsi2=rsiArr(c,2);
    let i=SMA_LEN;
    while(i<b.length){
      const rising=sma200[i-RISING_LB]!=null&&sma200[i]>sma200[i-RISING_LB];
      if(sma200[i]!=null&&b[i].t>=cutoff&&c[i]>sma200[i]&&rising&&rsi2[i]!=null&&rsi2[i]<RSI_THR){
        const entry=c[i],stop=entry*(1-SL),tp=entry*(1+TP);
        let ex=null,reason=null,j=i+1,held=0;
        for(;j<b.length&&held<HOLD;j++,held++){
          if(l[j]<=stop){ex=stop;reason='stop';break;}
          if(h[j]>=tp){ex=tp;reason='target';break;}
        }
        if(ex==null){ex=c[Math.min(j,b.length-1)];reason='time';}
        const ret=(ex-entry)/entry-COMM;
        R.push(ret);
        if(reason==='target')exTgt++;else if(reason==='stop')exStop++;else exTime++;
        const d=new Date(b[i].t*1000).toISOString().slice(0,10);
        if(!firstDate||d<firstDate)firstDate=d; if(!lastDate||d>lastDate)lastDate=d;
        i=(j<b.length?j:b.length)+1;
      } else i++;
    }
    ok++;
  }catch(e){err++;}
  if((z+1)%100===0)console.error(`  ${z+1}/${syms.length} (ok ${ok}, err ${err}, trades ${R.length})`);
  await sleep(105);
}
const n=R.length, wins=R.filter(r=>r>0), losses=R.filter(r=>r<=0);
const gp=wins.reduce((a,r)=>a+r,0)*NOTIONAL, gl=-losses.reduce((a,r)=>a+r,0)*NOTIONAL;
const net=R.reduce((a,r)=>a+r,0)*NOTIONAL;
const sum=a=>a.reduce((x,y)=>x+y,0);
const stats={
  config:`RSI2<${RSI_THR} & close>SMA200 & SMA200 rising(${RISING_LB}) -> TP +${TP*100}% / stop -${SL*100}% / ${HOLD}-bar`,
  universe:`Pluang top-${TOP_N}`, window:`${firstDate} .. ${lastDate} (~${YEARS}y)`, commission:`${COMM*100}% round-trip`,
  symbols_ok:ok, symbols_err:err,
  trades:n, wins:wins.length, losses:losses.length,
  win_rate_pct:+(wins.length/n*100).toFixed(1),
  profit_factor:+(gp/gl).toFixed(3),
  total_pnl_usd:+net.toFixed(0),
  avg_trade_pct:+(sum(R)/n*100).toFixed(3),
  avg_win_pct:+(sum(wins)/wins.length*100).toFixed(2),
  avg_loss_pct:+(sum(losses)/losses.length*100).toFixed(2),
  best_trade_pct:+(Math.max(...R)*100).toFixed(1), worst_trade_pct:+(Math.min(...R)*100).toFixed(1),
  exit_breakdown:{target_pct:+(exTgt/n*100).toFixed(1), stop_pct:+(exStop/n*100).toFixed(1), time_pct:+(exTime/n*100).toFixed(1)},
  note:'$1,000 notional/trade, one position at a time per symbol; stop/target assumed filled intrabar at the level; current-constituents universe.',
};
writeFileSync('./bow_verify_stats.json',JSON.stringify(stats,null,2));
console.log(JSON.stringify(stats,null,2));
