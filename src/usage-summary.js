(function(root){
  'use strict';
  const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  function summarize(days,now=new Date()){
    const daily=new Map();for(const d of days){const v=daily.get(d.date)||{tokens:0,requests:0};v.tokens+=Number(d.input||0)+Number(d.output||0)+Number(d.cache||0)+Number(d.cacheCreate||0);v.requests+=Number(d.requests||0);daily.set(d.date,v);}
    const active=[...daily].filter(([,v])=>v.tokens>0).map(([date])=>date).sort();
    let longest=0,run=0,previous=null;
    for(const date of active){const d=new Date(date+'T12:00:00');const yesterday=new Date(d);yesterday.setDate(d.getDate()-1);run=previous===key(yesterday)?run+1:1;longest=Math.max(longest,run);previous=date;}
    let current=0;const day=new Date(now);day.setHours(12,0,0,0);while(daily.get(key(day))?.tokens>0){current++;day.setDate(day.getDate()-1);}
    return {total:[...daily.values()].reduce((n,d)=>n+d.tokens,0),peak:Math.max(0,...[...daily.values()].map(d=>d.tokens)),activeDays:active.length,current,longest};
  }
  function compact(value){
    const n=Number(value);if(!Number.isFinite(n)||n<0)return '0';
    for(const [unit,scale] of [['T',1e12],['B',1e9],['M',1e6],['K',1e3]]){
      if(n<scale)continue;
      const amount=n/scale;let rounded=Number(amount.toFixed(2));
      // 未达到下一级阈值时，避免四舍五入显示为 1000K 等形式。
      if(amount<1000&&rounded>=1000)rounded=999.99;
      return `${rounded}${unit}`;
    }
    return n.toLocaleString();
  }
  const ns=root[Symbol.for('agy.kit')]||root;
  const api={summarize,compact,dateKey:key};if(typeof module==='object'&&module.exports)module.exports=api;else ns.__AGY_KIT_USAGE__=api;
})(typeof window==='object'?window:globalThis);
