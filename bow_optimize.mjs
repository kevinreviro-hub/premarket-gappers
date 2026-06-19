#!/usr/bin/env node
// bow_optimize.mjs — Buy-on-Weakness (mean-reversion) parameter search WITH commission.
// Entry: close>SMA200 AND 200-SMA rising AND RSI(2)<thr. Exits tuned for BIGGER avg/trade
// (let the bounce run). Commission 0.2% buy + 0.2% sell = 0.4% round-trip subtracted per trade.
// Goal: WR>60% AND PF>1.3 AND avg/trade>1% (net of commission). top-500, last 3y, $1k/trade.
import { readFileSync } from 'node:fs';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE='5y',YEARS=3,SMA_LEN=200,NOTIONAL=1000,COMM=0.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parseCsv=t=>{const R=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===','){r.push(f);f='';}else if(c==='\n'){r.push(f);R.push(r);r=[];f='';}else if(c!=='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R;};
function loadSymbols(){const rows=parseCsv(readFileSync('./pluang_us_stocks.csv','utf8'));const head=rows[0].map(h=>h.trim().toLowerCase());const si=head.indexOf('symbol'),ei=head.indexOf('is_trading_enabled');const o=[];for(let r=1;r<rows.length&&o.length<TOP_N;r++){const s=(rows[r][si]||'').trim().toUpperCase();const e=ei>=0?(rows[r][ei]||'TRUE').trim().toUpperCase():'TRUE';if(s&&e!=='FALSE')o.push(s);}return o;}
async function fetchDaily(sym,tries=2){const y=sym.replace(/\./g,'-');const host=tries%2?'query1':'query2';const u=`https://${host}.finance.yahoo.com/v8/finance/chart/${y}?range=${RANGE}&interval=1d`;try{const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();const res=j.chart&&j.chart.result&&j.chart.result[0];if(!res||!res.timestamp)throw new Error('no data');const q=res.indicators.quote[0],b=[];for(let i=0;i<res.timestamp.length;i++){if(q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null)continue;b.push({t:res.timestamp[i],h:q.high[i],l:q.low[i],c:q.close[i]});}return b;}catch(e){if(tries>1){await sleep(500);return fetchDaily(sym,tries-1);}throw e;}}
const smaArr=(a,n)=>{const o=Array(a.length).fill(null);let r=0;for(let i=0;i<a.length;i++){r+=a[i];if(i>=n)r-=a[i-n];if(i>=n-1)o[i]=r/n;}return o;};
function rsiArr(c,n){const o=Array(c.length).fill(null);let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g;al+=l;if(i===n){ag/=n;al/=n;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}

// exit configs: ind exit (close>SMAx | rsi2>70), optional take-profit tp, stop sl, max hold
const EXITS=[
  {name:'sma20 tp- sl12 h30',  ind:'sma20',tp:null, sl:0.12, hold:30},   // best-WR reference
  {name:'tp12  only sl12 h30',  ind:null,   tp:0.12, sl:0.12, hold:30},   // best-avg reference
  {name:'tp15  only sl12 h40',  ind:null,   tp:0.15, sl:0.12, hold:40},
  {name:'tp20  only sl15 h60',  ind:null,   tp:0.20, sl:0.15, hold:60},
  {name:'tp25  only sl15 h60',  ind:null,   tp:0.25, sl:0.15, hold:60},
  {name:'sma50 tp- sl15 h60',  ind:'sma50',tp:null, sl:0.15, hold:60},
  {name:'sma50 tp20 sl15 h60', ind:'sma50',tp:0.20, sl:0.15, hold:60},
  {name:'sma50 tp15 sl12 h40', ind:'sma50',tp:0.15, sl:0.12, hold:40},
];
const THRS=[5,10];
const acc={}; for(const th of THRS)for(const e of EXITS)acc[th+'|'+e.name]={n:0,w:0,gp:0,gl:0,net:0,sumr:0};

const syms=loadSymbols();
const cutoff=Math.floor(Date.now()/1000)-Math.round(YEARS*365.25*86400);
console.error(`BOW optimize (commission ${COMM*100}%): ${syms.length} symbols, last ${YEARS}y`);
let ok=0,err=0;
for(let z=0;z<syms.length;z++){
  try{
    const b=await fetchDaily(syms[z]); if(b.length<SMA_LEN+30){err++;await sleep(105);continue;}
    const c=b.map(x=>x.c),l=b.map(x=>x.l),h=b.map(x=>x.h);
    const sma200=smaArr(c,200),sma5=smaArr(c,5),sma10=smaArr(c,10),sma20=smaArr(c,20),sma50=smaArr(c,50),rsi2=rsiArr(c,2);
    const smaOf={sma5,sma10,sma20,sma50};
    for(const th of THRS)for(const e of EXITS){const A=acc[th+'|'+e.name];let i=SMA_LEN;
      while(i<b.length){
        const rising=sma200[i-20]!=null&&sma200[i]>sma200[i-20];
        if(sma200[i]!=null&&b[i].t>=cutoff&&c[i]>sma200[i]&&rising&&rsi2[i]!=null&&rsi2[i]<th){
          const entry=c[i],stop=entry*(1-e.sl),tp=e.tp?entry*(1+e.tp):Infinity;
          let ex=null,j=i+1,held=0;
          for(;j<b.length&&held<e.hold;j++,held++){
            if(l[j]<=stop){ex=stop;break;}
            if(h[j]>=tp){ex=tp;break;}
            if(e.ind){const done = e.ind==='rsi70'?(rsi2[j]!=null&&rsi2[j]>70):(smaOf[e.ind][j]!=null&&c[j]>smaOf[e.ind][j]); if(done){ex=c[j];break;}}
          }
          if(ex==null)ex=c[Math.min(j,b.length-1)];
          const ret=(ex-entry)/entry-COMM, pnl=NOTIONAL*ret;
          A.n++;A.net+=pnl;A.sumr+=ret;if(pnl>0){A.w++;A.gp+=pnl;}else A.gl+=-pnl;
          i=(j<b.length?j:b.length)+1;
        } else i++;
      }
    }
    ok++;
  }catch(e){err++;}
  if((z+1)%50===0)console.error(`  ${z+1}/${syms.length} (ok ${ok}, err ${err})`);
  await sleep(105);
}
console.log(`\nfetched ok ${ok}, err ${err}.  NET of ${COMM*100}% commission.  ** = WR>=60% & PF>=1.3 & avg>=1%\n`);
console.log('  thr exit'.padEnd(30)+'n      WR%    PF     avg%    net$');
const rows=[];for(const th of THRS)for(const e of EXITS){const A=acc[th+'|'+e.name];if(!A.n)continue;const wr=A.w/A.n*100,pf=A.gl>0?A.gp/A.gl:Infinity,avg=A.sumr/A.n*100;rows.push({k:`RSI2<${th} ${e.name}`,n:A.n,wr,pf,avg,net:A.net});}
for(const r of rows.sort((a,b)=>b.avg-a.avg)){const flag=(r.wr>=60&&r.pf>=1.3&&r.avg>=1)?'  **':'';console.log('  '+r.k.padEnd(28)+String(r.n).padStart(5)+'  '+r.wr.toFixed(1).padStart(5)+'  '+r.pf.toFixed(3).padStart(6)+'  '+r.avg.toFixed(3).padStart(6)+'  '+String(Math.round(r.net)).padStart(7)+flag);}
