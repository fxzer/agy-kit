(function () {
  'use strict';
  const ns=window[Symbol.for('agy.kit')]||window;
  const controllers=new Set();
  async function call(endpoint,data={},timeout=90000,signal){
    const config=ns.bridgeConfig||window.__AGY_KIT_BRIDGE_CONFIG__;
    if(!config)throw new Error('本地辅助服务尚未连接，请运行 agy-kit live 或重新安装');
    const controller=new AbortController();const onAbort=()=>controller.abort();if(signal?.aborted)controller.abort();signal?.addEventListener('abort',onAbort,{once:true});controllers.add(controller);const timer=setTimeout(()=>controller.abort(),timeout);
    try{
      const response=await fetch(config.url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},body:JSON.stringify(data),signal:controller.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`本地接口 HTTP ${response.status}`);return result;
    }finally{clearTimeout(timer);controllers.delete(controller);signal?.removeEventListener('abort',onAbort);}
  }
  const recorded=new Map();
  let recordQueue=Promise.resolve(),destroyed=false;
  function record(session,rows,steps,offset=0){
    // 所有调用等待前批落盘后再去重，不能把别的面板尚在途的写入当成成功。
    const job=recordQueue.then(async()=>{
      if(destroyed)throw new Error('本地归档已停止');
      const records=[];
      for(const row of rows){
        const chat=row.chatModel,usage=chat?.usage,index=row.stepIndices?.at(-1);
        const step=Number.isInteger(index)?steps[index-offset]:null;
        if(!usage||!step||!usage.outputTokens)continue;
        const at=new Date(step.metadata?.createdAt);if(Number.isNaN(at.getTime()))continue;
        const date=`${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')}`;
        const rec={session,step:index,source:'desktop',date,at:Math.floor(at.getTime()/1000),model:chat.modelDisplayName||chat.responseModel||chat.model,input:Number(usage.inputTokens||0),output:Number(usage.outputTokens||0),cache:Number(usage.cacheReadTokens||0),cacheCreate:Number(usage.cacheCreationTokens||0)};
        const key=`${session}:${index}`,fingerprint=JSON.stringify(rec);
        if(recorded.get(key)!==fingerprint){recorded.set(key,fingerprint);records.push(rec);}
      }
      if(recorded.size>10000)recorded.delete(recorded.keys().next().value);
      if(records.length)try{for(let i=0;i<records.length;i+=250)await call('/record',{records:records.slice(i,i+250)},15000);}catch(error){for(const rec of records)recorded.delete(`${session}:${rec.step}`);throw error;}
    });
    recordQueue=job.catch(()=>{});
    return job;
  }
  const client={call,record,destroy(){destroyed=true;for(const c of controllers)c.abort();controllers.clear();}};
  ns.__AGY_KIT_BRIDGE_CLIENT__=client;
  ns.bridgeClient=client;
})();
