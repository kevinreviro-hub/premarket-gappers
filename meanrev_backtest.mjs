#!/usr/bin/env node
// meanrev_backtest.mjs — Connors-style mean-reversion over the Pluang top-N (last YEARS).
// Entry: close > SMA200 (uptrend) AND RSI(2) < oversold (sharp pullback) -> buy at close.
// Exit: bounce done (close>SMA5 OR RSI2>50, per variant) OR protective stop OR time stop.
// Sweeps oversold x exitRule x stop. $1,000/trade, one position at a time, no commission.
import { readFileSync, writeFileSync } from 'node:fs';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE = '5y', YEARS = 3, MAXHOLD = 10, SMA_LEN = 200, NOTIONAL = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseCsv = t => { const R=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===','){r.push(f);f='';}else if(c==='\n'){r.push(f);R.push(r);r=[];f='';}else if(c!=='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R; };
function loadSymbols(){const rows=parseCsv(readFileSync('./pluang_us_stocks.csv','utf8'));const head=rows[0].map(h=>h.trim().toLowerCase());const si=head.indexOf('symbol'),ei=head.indexOf('is_trading_enabled');const o=[];for(let r=1;r<rows.length&&o.length<TOP_N;r++){const s=(rows[r][si]||'').trim().toUpperCase();const e=ei>=0?(rows[r][ei]||'TRUE').trim().toUpperCase():'TRUE';if(s&&e!=='FALSE')o.push(s);}return o;}
async function fetchDaily(sym,tries=2){const y=sym.replace(/\./g,'-');const host=tries%2?'query1':'query2';const u=`https://${host}.finance.yahoo.com/v8/finance/chart/${y}?range=${RANGE}&interval=1d`;try{const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();const res=j.chart&&j.chart.result&&j.chart.result[0];if(!res||!res.timestamp)throw new Error('no data');const q=res.indicators.quote[0],b=[];for(let i=0;i<res.timestamp.length;i++){if(q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null)continue;b.push({t:res.timestamp[i],h:q.high[i],l:q.low[i],c:q.close[i]});}return b;}catch(e){if(tries>1){await sleep(500);return fetchDaily(sym,tries-1);}throw e;}}
const smaArr=(a,n)=>{const o=Array(a.length).fill(null);let r=0;for(let i=0;i<a.length;i++){r+=a[i];if(i>=n)r-=a[i-n];if(i>=n-1)o[i]=r/n;}return o;};
function rsiArr(c,n){const o=Array(c.length).fill(null);let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}

const OVERSOLD=[5,10,15], EXITS=['sma5','rsi50'], STOPS=[0,0.10];
const variants=[]; for(const ov of OVERSOLD)for(const ex of EXITS)for(const st of STOPS)variants.push({ov,ex,st,key:`RSI2<${ov}|exit:${ex}|stop:${st?st*100+'%':'none'}`});
const PRIMARY='RSI2<10|exit:sma5|stop:10%';
const acc={}; for(const v of variants)acc[v.key]={n:0,w:0,gp:0,gl:0,net:0};
const perSym={};

const syms=loadSymbols();
const cutoff=Math.floor(Date.now()/1000)-Math.round(YEARS*365.25*86400);
console.error(`mean-reversion sweep: ${syms.length} symbols, last ${YEARS}y, ${variants.length} variants`);
let ok=0,err=0;
for(let z=0;z<syms.length;z++){
  try{
    const b=await fetchDaily(syms[z]); if(b.length<SMA_LEN+30){err++;await sleep(105);continue;}
    const c=b.map(x=>x.c),h=b.map(x=>x.h),l=b.map(x=>x.l);
    const sma200=smaArr(c,200),sma5=smaArr(c,5),rsi2=rsiArr(c,2);
    for(const v of variants){const A=acc[v.key];let i=SMA_LEN;
      while(i<b.length){
        if(sma200[i]!=null && b[i].t>=cutoff && c[i]>sma200[i] && rsi2[i]!=null && rsi2[i]<v.ov){
          const entry=c[i],stop=v.st?entry*(1-v.st):-Infinity;let ex=null,j=i+1,held=0;
          for(;j<b.length&&held<MAXHOLD;j++,held++){
            if(v.st && l[j]<=stop){ex=stop;break;}
            const done = v.ex==='sma5' ? (sma5[j]!=null&&c[j]>sma5[j]) : (rsi2[j]!=null&&rsi2[j]>50);
            if(done){ex=c[j];break;}
          }
          if(ex==null)ex=c[Math.min(j,b.length-1)];
          const pnl=NOTIONAL*(ex-entry)/entry; A.n++; A.net+=pnl; if(pnl>0){A.w++;A.gp+=pnl;}else A.gl+=-pnl;
          if(v.key===PRIMARY){const p=perSym[syms[z]]||(perSym[syms[z]]={trades:0,wins:0,net:0});p.trades++;if(pnl>0)p.wins++;p.net+=pnl;}
          i=(j<b.length?j:b.length)+1;
        } else i++;
      }
    }
    ok++;
  }catch(e){err++;}
  if((z+1)%50===0)console.error(`  ${z+1}/${syms.length} (ok ${ok}, err ${err})`);
  await sleep(105);
}
const rows=variants.map(v=>{const A=acc[v.key];const wr=A.n?A.w/A.n*100:0,pf=A.gl>0?A.gp/A.gl:Infinity;return{key:v.key,n:A.n,wr:+wr.toFixed(1),pf:+pf.toFixed(3),net:+A.net.toFixed(0),avg:A.n?+((A.net/A.n)/NOTIONAL*100).toFixed(3):0};});
console.log(`\nfetched ok ${ok}, err ${err}.  ** = WR>=60% AND PF>=1.3\n`);
console.log('  variant'.padEnd(34)+'  n      WR%    PF     net$     avg%');
for(const r of rows.sort((a,b)=>b.pf-a.pf)){const flag=(r.wr>=60&&r.pf>=1.3)?'  **':'';console.log('  '+r.key.padEnd(32)+String(r.n).padStart(5)+'  '+String(r.wr).padStart(5)+'  '+String(r.pf).padStart(6)+'  '+String(r.net).padStart(7)+'  '+String(r.avg).padStart(6)+flag);}
const P=acc[PRIMARY],pwr=P.w/P.n*100,ppf=P.gp/P.gl;
console.log(`\nPRIMARY variant (${PRIMARY}) combined: ${P.n} trades, WR ${pwr.toFixed(1)}%, PF ${ppf.toFixed(3)}, total P&L $${P.net.toFixed(0)}`);
writeFileSync('./meanrev_combined.json',JSON.stringify({rows,primary:PRIMARY,perSym},null,0));
const e=Object.entries(perSym).filter(([k,v])=>v.trades>=3).sort((a,b)=>b[1].net-a[1].net);
console.log('\nTOP 6 (primary):'); e.slice(0,6).forEach(([k,v])=>console.log('  '+k.padEnd(6)+' net $'+v.net.toFixed(0)+' | '+v.trades+'tr '+Math.round(v.wins/v.trades*100)+'%win'));
console.log('BOTTOM 6 (primary):'); e.slice(-6).reverse().forEach(([k,v])=>console.log('  '+k.padEnd(6)+' net $'+v.net.toFixed(0)+' | '+v.trades+'tr '+Math.round(v.wins/v.trades*100)+'%win'));
