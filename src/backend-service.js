'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { HistoryStore } = require('./history-store');
const ORIGIN = /^https:\/\/127\.0\.0\.1:\d+$/;
const settings=require('./settings-store');
// 进程加载时固定指纹；文件更新后，旧进程不能继续被当作最新后端复用。
const build=crypto.createHash('sha256').update(Buffer.concat(['backend-service.js','history-store.js','settings-store.js'].map(file=>fs.readFileSync(path.join(__dirname,file))))).digest('hex');
let singleton;
async function start(options={}) {
  if(singleton)return singleton;
  singleton=new Promise((resolve,reject)=>{
    const token=crypto.randomBytes(32).toString('hex');
    const store=new HistoryStore(options);
    const settingsFile=path.join(options.stateDir||path.join(options.home||os.homedir(),'.gemini/agy-kit'),'settings.json');
    let writeQueue=Promise.resolve();
    const server=http.createServer(async(req,res)=>{
      const origin=req.headers.origin||'';
      if(!ORIGIN.test(origin)){res.writeHead(403);res.end();return;}
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Vary','Origin');res.setHeader('Cache-Control','no-store');
      if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Private-Network':'true'});res.end();return;}
      if(req.method!=='POST'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}
      const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
      try{
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw new Error('请求超过 2 MiB');}
        const data=body?JSON.parse(body):{};
        if(req.url==='/shutdown' && options.daemon){send(200,{ok:true});server.close(()=>process.exit());return;}
        if(req.url==='/settings')return send(200,data.modules?settings.write(data,settingsFile):settings.read(settingsFile));
        if(req.url==='/health')return send(200,{ok:true,version:1,build});
        if(req.url==='/record'){
          if(!Array.isArray(data.records)||data.records.length>500)throw new Error('记录格式或数量无效');
          const job=writeQueue.then(()=>store.record(data.records));writeQueue=job.catch(()=>{});await job;return send(200,{ok:true});
        }
        if(req.url==='/history'){await writeQueue;return send(200,await store.scan());}
        return send(404,{error:'未找到本地功能'});
      }catch(e){if(!res.headersSent)send(400,{error:e.message});else res.end();}
    });
    server.requestTimeout=90000;server.headersTimeout=10000;server.on('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const config={url:`http://127.0.0.1:${server.address().port}`,token,get settings(){return settings.read(settingsFile);}};
      if(options.publish !== false){fs.mkdirSync(path.dirname(runtimeInfo),{recursive:true,mode:0o700});fs.writeFileSync(runtimeInfo,JSON.stringify({...config,pid:process.pid,daemon:!!options.daemon}),{mode:0o600});fs.chmodSync(runtimeInfo,0o600);}
      resolve({config,close:()=>new Promise(r=>server.close(()=>{singleton=null;r();})),server});
    });
  });
  try{return await singleton;}catch(e){singleton=null;throw e;}
}
const runtimeInfo=path.join(os.homedir(),'.gemini/agy-kit/backend-info.json');
async function ensureDaemon() {
  try{
    const previous=JSON.parse(fs.readFileSync(runtimeInfo,'utf8'));
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.url)||!/^\w{64}$/.test(previous.token))throw new Error('无效运行状态');
    const response=await fetch(previous.url+'/health',{method:'POST',headers:{Origin:'https://127.0.0.1:1',Authorization:`Bearer ${previous.token}`},signal:AbortSignal.timeout(1000)});
    if(response.ok){
      const health=await response.json();
      if(health.build===build)return previous;
      if(previous.daemon)await fetch(previous.url+'/shutdown',{method:'POST',headers:{Origin:'https://127.0.0.1:1',Authorization:`Bearer ${previous.token}`},signal:AbortSignal.timeout(5000)});
    }
  }catch{}
  const {spawn}=require('child_process');
  const child=spawn(process.execPath,[__filename,'--daemon'],{detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});child.unref();
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));try{const previous=JSON.parse(fs.readFileSync(runtimeInfo,'utf8'));if(previous.pid===child.pid)return previous;}catch{}}
  throw new Error('本地辅助服务未能启动');
}
if(require.main===module&&process.argv.includes('--daemon')){
  start({daemon:true}).then(({config})=>{
    fs.mkdirSync(path.dirname(runtimeInfo),{recursive:true,mode:0o700});
    fs.writeFileSync(runtimeInfo,JSON.stringify({...config,pid:process.pid,daemon:true}),{mode:0o600});
    // 热更新辅助进程随客户端退出释放；不会反复扫描历史文件。
    let hostPids=[];try{hostPids=require('child_process').execFileSync('/usr/bin/pgrep',['-x','Antigravity'],{encoding:'utf8'}).trim().split(/\s+/).map(Number);}catch{}
    const timer=setInterval(()=>{const alive=hostPids.some(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});if(!alive){clearInterval(timer);process.exit();}},10000);
  }).catch(()=>process.exit(1));
}
module.exports={start,ensureDaemon};
