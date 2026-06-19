#!/usr/bin/env node
// tjl_filter_exit.mjs — fetch once, then sweep EXIT settings (stop% x reward:risk) crossed
// with a few entry-filter sets, to find a config hitting WR>60% AND PF>1.3. Shows that the
// win-rate lever is the target distance, while filters drive profit factor.
import { readFileSync } from 'node:fs';
const TOP_N = parseInt(process.env.TOP_N || '500', 10);
const RANGE = '5y', YEARS = 3, MAXHOLD = 10, SMA_LEN = 200, NOTIONAL = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseCsv = t => { const R=[];let r=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c==='"')q=true;else if(c===',' ){r.push(f);f='';}else if(c==='\n'){r.push(f);R.push(r);r=[];f='';}else if(c!=='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R; };
function loadSymbols(){const rows=parseCsv(readFileSync('./pluang_us_stocks.csv','utf8'));const head=rows[0].map(h=>h.trim().toLowerCase());const si=head.indexOf('symbol'),ei=head.indexOf('is_trading_enabled');const o=[];for(let r=1;r<rows.length&&o.length<TOP_N;r++){const s=(rows[r][si]||'').trim().toUpperCase();const e=ei>=0?(rows[r][ei]||'TRUE').trim().toUpperCase():'TRUE';if(s&&e!=='FALSE')o.push(s);}return o;}
async function fetchDaily(sym,tries=2){const y=sym.replace(/\./g,'-');const host=tries%2?'query1':'query2';const u=`https://${host}.finance.yahoo.com/v8/finance/chart/${y}?range=${RANGE}&interval=1d`;try{const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('http '+r.status);const j=await r.json();const res=j.chart&&j.chart.result&&j.chart.result[0];if(!res||!res.timestamp)throw new Error('no data');const q=res.indicators.quote[0],b=[];for(let i=0;i<res.timestamp.length;i++){if(q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null)continue;b.push({t:res.timestamp[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]??0});}return b;}catch(e){if(tries>1){await sleep(500);return fetchDaily(sym,tries-1);}throw e;}}
const smaArr=(a,n)=>{const o=Array(a.length).fill(null);let r=0;for(let i=0;i<a.length;i++){r+=a[i];if(i>=n)r-=a[i-n];if(i>=n-1)o[i]=r/n;}return o;};
function adxArr(h,l,c,n){const len=c.length,pdm=Array(len).fill(0),ndm=Array(len).fill(0),tr=Array(len).fill(0);for(let i=1;i<len;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];pdm[i]=(up>dn&&up>0)?up:0;ndm[i]=(dn>up&&dn>0)?dn:0;tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));}const str=Array(len).fill(null),sp=Array(len).fill(null),sn=Array(len).fill(null);let t=0,p=0,m=0;for(let i=1;i<len;i++){if(i<=n){t+=tr[i];p+=pdm[i];m+=ndm[i];if(i===n){str[i]=t;sp[i]=p;sn[i]=m;}}else{str[i]=str[i-1]-str[i-1]/n+tr[i];sp[i]=sp[i-1]-sp[i-1]/n+pdm[i];sn[i]=sn[i-1]-sn[i-1]/n+ndm[i];}}const dx=Array(len).fill(null);for(let i=n;i<len;i++)if(str[i]>0){const pD=100*sp[i]/str[i],nD=100*sn[i]/str[i],s=pD+nD;dx[i]=s===0?0:100*Math.abs(pD-nD)/s;}const adx=Array(len).fill(null);let a=null,cnt=0,sum=0;for(let i=n;i<len;i++){if(dx[i]==null)continue;if(a==null){sum+=dx[i];cnt++;if(cnt===n){a=sum/n;adx[i]=a;}}else{a=(a*(n-1)+dx[i])/n;adx[i]=a;}}return adx;}
const emaArr=(a,n)=>{const o=Array(a.length).fill(null),k=2/(n+1);let p=null;for(let i=0;i<a.length;i++){p=p==null?a[i]:a[i]*k+p*(1-k);o[i]=p;}return o;};

// entry-filter sets, evaluated at signal bar i using precomputed arrays
const FILTERSETS = {
  'none': () => true,
  'quality(macd+ADX25+dist12+>50sma)': (x,i)=> x.macd[i]>x.sig[i] && x.adx[i]!=null&&x.adx[i]>=25 && x.dist(i)<=12 && x.c[i]>x.sma50[i],
  'strongPF(golden+vol1.5+dist12+>50sma)': (x,i)=> x.sma50[i]>x.sma200[i] && x.vol[i]>=1.5 && x.dist(i)<=12 && x.c[i]>x.sma50[i],
};
const STOPS=[0.03,0.05], RRS=[0.75,1.0,1.25,1.5,2.0];

const syms=loadSymbols();
const cutoff=Math.floor(Date.now()/1000)-Math.round(YEARS*365.25*86400);
console.error(`exit x filter sweep: ${syms.length} symbols, last ${YEARS}y`);
// acc[filter][stop_rr] = {n,w,gp,gl}
const acc={}; for(const fs in FILTERSETS) for(const s of STOPS) for(const rr of RRS) acc[fs+'|'+s+'|'+rr]={n:0,w:0,gp:0,gl:0};
let ok=0,err=0;
for(let z=0;z<syms.length;z++){
  try{
    const b=await fetchDaily(syms[z]); if(b.length<SMA_LEN+30){err++;await sleep(105);continue;}
    const c=b.map(x=>x.c),h=b.map(x=>x.h),l=b.map(x=>x.l),v=b.map(x=>x.v);
    const sma200=smaArr(c,200),sma50=smaArr(c,50),vol20=smaArr(v,20),adx=adxArr(h,l,c,14);
    const e12=emaArr(c,12),e26=emaArr(c,26),macd=c.map((_,i)=>e12[i]-e26[i]),sig=emaArr(macd,9);
    const x={c,h,l,sma200,sma50,adx,macd,sig,vol:c.map((_,i)=>vol20[i]?v[i]/vol20[i]:0),dist:i=>sma200[i]?(c[i]/sma200[i]-1)*100:999};
    for(const fsName in FILTERSETS){const pass=FILTERSETS[fsName];
      for(const stop of STOPS){for(const rr of RRS){
        const key=fsName+'|'+stop+'|'+rr; const A=acc[key];
        let i=SMA_LEN;
        while(i<b.length){
          if(sma200[i-1]!=null && b[i].t>=cutoff && c[i]>h[i-1] && c[i-1]>sma200[i-1] && pass(x,i)){
            const entry=c[i],sl=entry*(1-stop),tp=entry*(1+stop*rr);let ex=null,j=i+1,held=0;
            for(;j<b.length&&held<MAXHOLD;j++,held++){if(l[j]<=sl){ex=sl;break;}if(h[j]>=tp){ex=tp;break;}}
            if(ex==null)ex=c[Math.min(j,b.length-1)];
            const pnl=NOTIONAL*(ex-entry)/entry; A.n++; if(pnl>0){A.w++;A.gp+=pnl;}else A.gl+=-pnl;
            i=(j<b.length?j:b.length)+1;
          } else i++;
        }
      }}
    }
    ok++;
  }catch(e){err++;}
  if((z+1)%50===0)console.error(`  ${z+1}/${syms.length} (ok ${ok}, err ${err})`);
  await sleep(105);
}
console.log(`\nfetched ok ${ok}, err ${err}\nWR>=60% & PF>=1.3 marked **\n`);
for(const fs in FILTERSETS){
  console.log(`\n=== FILTER: ${fs} ===`);
  console.log('  stop  RR    n     WR%    PF     avgRet%');
  for(const stop of STOPS)for(const rr of RRS){const A=acc[fs+'|'+stop+'|'+rr];if(!A.n)continue;const wr=A.w/A.n*100,pf=A.gl>0?A.gp/A.gl:Infinity;const flag=(wr>=60&&pf>=1.3)?' **':'';const avg=((A.gp-A.gl)/A.n)/NOTIONAL*100;console.log(`  ${(stop*100).toFixed(0)}%  ${rr.toFixed(2)}  ${String(A.n).padStart(5)}  ${wr.toFixed(1).padStart(5)}  ${pf.toFixed(3).padStart(6)}  ${avg.toFixed(3).padStart(6)}${flag}`);}
}
