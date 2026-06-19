#!/usr/bin/env node
// meanrev_refine.mjs — push the mean-reversion PF over 1.3 (keeping WR>60%) via light
// entry-quality filters: SPY market regime, stock 200-SMA rising, golden cross.
// Base: close>SMA200 AND RSI2<thr -> buy; exit close>SMA5 OR 10% stop OR 10-bar.
import { readFileSync } from 'node:fs';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE='5y',YEARS=3,MAXHOLD=10,SMA_LEN=200,NOTIONAL=1000,STOP=0.10;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parseCsv=t=>{const R=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===','){r.push(f);f='';}else if(c==='\n'){r.push(f);R.push(r);r=[];f='';}else if(c!=='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R;};
function loadSymbols(){const rows=parseCsv(readFileSync('./pluang_us_stocks.csv','utf8'));const head=rows[0].map(h=>h.trim().toLowerCase());const si=head.indexOf('symbol'),ei=head.indexOf('is_trading_enabled');const o=[];for(let r=1;r<rows.length&&o.length<TOP_N;r++){const s=(rows[r][si]||'').trim().toUpperCase();const e=ei>=0?(rows[r][ei]||'TRUE').trim().toUpperCase():'TRUE';if(s&&e!=='FALSE')o.push(s);}return o;}
async function fetchDaily(sym,tries=2){const y=sym.replace(/\./g,'-');const host=tries%2?'query1':'query2';const u=`https://${host}.finance.yahoo.com/v8/finance/chart/${y}?range=${RANGE}&interval=1d`;try{const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();const res=j.chart&&j.chart.result&&j.chart.result[0];if(!res||!res.timestamp)throw new Error('no data');const q=res.indicators.quote[0],b=[];for(let i=0;i<res.timestamp.length;i++){if(q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null)continue;b.push({t:res.timestamp[i],h:q.high[i],l:q.low[i],c:q.close[i]});}return b;}catch(e){if(tries>1){await sleep(500);return fetchDaily(sym,tries-1);}throw e;}}
const smaArr=(a,n)=>{const o=Array(a.length).fill(null);let r=0;for(let i=0;i<a.length;i++){r+=a[i];if(i>=n)r-=a[i-n];if(i>=n-1)o[i]=r/n;}return o;};
function rsiArr(c,n){const o=Array(c.length).fill(null);let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}

async function spyAbove200(){const b=await fetchDaily('SPY');const c=b.map(x=>x.c),s=smaArr(c,200),m={};for(let i=0;i<b.length;i++){const d=new Date(b[i].t*1000).toISOString().slice(0,10);m[d]=s[i]!=null?c[i]>s[i]:null;}return m;}

const FILTERS={
  'none':()=>true,
  'spyUp':(x,i)=>x.spy[x.date(i)]===true,
  'rising200':(x,i)=>x.sma200[i-20]!=null&&x.sma200[i]>x.sma200[i-20],
  'golden':(x,i)=>x.sma50[i]!=null&&x.sma50[i]>x.sma200[i],
  'spyUp+rising200':(x,i)=>x.spy[x.date(i)]===true&&x.sma200[i-20]!=null&&x.sma200[i]>x.sma200[i-20],
  'spyUp+rising200+golden':(x,i)=>x.spy[x.date(i)]===true&&x.sma200[i-20]!=null&&x.sma200[i]>x.sma200[i-20]&&x.sma50[i]!=null&&x.sma50[i]>x.sma200[i],
};
const THRS=[5,10];
const acc={}; for(const th of THRS)for(const fn in FILTERS)acc[th+'|'+fn]={n:0,w:0,gp:0,gl:0,net:0};

const syms=loadSymbols();
const cutoff=Math.floor(Date.now()/1000)-Math.round(YEARS*365.25*86400);
console.error(`mean-rev refine: ${syms.length} symbols, last ${YEARS}y`);
const spy=await spyAbove200();
let ok=0,err=0;
for(let z=0;z<syms.length;z++){
  try{
    const b=await fetchDaily(syms[z]); if(b.length<SMA_LEN+30){err++;await sleep(105);continue;}
    const c=b.map(x=>x.c),h=b.map(x=>x.h),l=b.map(x=>x.l);
    const sma200=smaArr(c,200),sma50=smaArr(c,50),sma5=smaArr(c,5),rsi2=rsiArr(c,2);
    const x={sma200,sma50,spy,date:i=>new Date(b[i].t*1000).toISOString().slice(0,10)};
    for(const th of THRS)for(const fn in FILTERS){const pass=FILTERS[fn],A=acc[th+'|'+fn];let i=SMA_LEN;
      while(i<b.length){
        if(sma200[i]!=null&&b[i].t>=cutoff&&c[i]>sma200[i]&&rsi2[i]!=null&&rsi2[i]<th&&pass(x,i)){
          const entry=c[i],stop=entry*(1-STOP);let ex=null,j=i+1,held=0;
          for(;j<b.length&&held<MAXHOLD;j++,held++){if(l[j]<=stop){ex=stop;break;}if(sma5[j]!=null&&c[j]>sma5[j]){ex=c[j];break;}}
          if(ex==null)ex=c[Math.min(j,b.length-1)];
          const pnl=NOTIONAL*(ex-entry)/entry;A.n++;A.net+=pnl;if(pnl>0){A.w++;A.gp+=pnl;}else A.gl+=-pnl;
          i=(j<b.length?j:b.length)+1;
        } else i++;
      }
    }
    ok++;
  }catch(e){err++;}
  if((z+1)%50===0)console.error(`  ${z+1}/${syms.length} (ok ${ok}, err ${err})`);
  await sleep(105);
}
console.log(`\nfetched ok ${ok}, err ${err}.  ** = WR>=60% AND PF>=1.3\n`);
console.log('  thr filter'.padEnd(34)+'n      WR%    PF     net$     avg%');
const rows=[];for(const th of THRS)for(const fn in FILTERS){const A=acc[th+'|'+fn];if(!A.n)continue;const wr=A.w/A.n*100,pf=A.gl>0?A.gp/A.gl:Infinity;rows.push({k:`RSI2<${th} ${fn}`,n:A.n,wr,pf,net:A.net});}
for(const r of rows.sort((a,b)=>b.pf-a.pf)){const flag=(r.wr>=60&&r.pf>=1.3)?'  **':'';console.log('  '+r.k.padEnd(32)+String(r.n).padStart(5)+'  '+r.wr.toFixed(1).padStart(5)+'  '+r.pf.toFixed(3).padStart(6)+'  '+String(Math.round(r.net)).padStart(7)+'  '+((r.net/r.n)/NOTIONAL*100).toFixed(3).padStart(6)+flag);}
