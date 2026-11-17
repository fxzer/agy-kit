'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { cost } = require('./pricing');
const numeric = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const dateKey = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
function normalize(event, { session, source, line }) {
  const usage = event.chatModel?.usage || event.metadata?.modelUsage || event;
  const input = numeric(usage.inputTokens ?? usage.input_tokens), output = numeric(usage.outputTokens ?? usage.output_tokens);
  const cache = numeric(usage.cacheReadTokens ?? usage.cache_read_tokens), cacheCreate = numeric(usage.cacheCreationTokens ?? usage.cache_creation_tokens);
  const date = dateKey(event.created_at || event.createdAt || event.metadata?.createdAt);
  if (!date || !(input + output + cache + cacheCreate)) return null;
  const step = event.step_index ?? event.stepIndex ?? line;
  return { id: `${session}:${step}`, source, session, step, date, at:Math.floor(Date.parse(event.created_at || event.createdAt || event.metadata?.createdAt)/1000), model: String(event.chatModel?.modelDisplayName || event.model || event.modelId || usage.model || ''), input, output, cache, cacheCreate };
}
// transcript 和轨迹步骤编号不同；只在同一会话中按时间或实际用量逐条配对。
function mergeArchive(rows, archived) {
  const byTime=new Map(),byUsage=new Map(),used=new Set();
  const signature=r=>[r.session,r.date,r.input,r.output,r.cache,r.cacheCreate].join(':');
  const append=(index,key,id)=>{const list=index.get(key)||[];list.push(id);index.set(key,list);};
  for(const [id,r] of rows){append(byUsage,signature(r),id);if(Number.isInteger(r.at))append(byTime,`${r.session}:${r.at}`,id);}
  for(const r of archived){
    if(r.source==='cli')continue;
    const exact=(byUsage.get(signature(r))||[]).find(id=>!used.has(id));
    const timed=Number.isInteger(r.at)?(byTime.get(`${r.session}:${r.at}`)||[]).filter(id=>!used.has(id)):[];
    const id=exact??(timed.length===1?timed[0]:undefined);
    if(id!==undefined){const previous=rows.get(id);used.add(id);if(r.output>=previous.output)rows.set(id,{...previous,...r,id:previous.id,step:previous.step});else if(!previous.model&&r.model)rows.set(id,{...previous,model:r.model});}
    else rows.set(`archive:${r.id}`,r);
  }
}
class HistoryStore {
  constructor({ home = os.homedir(), stateDir = path.join(home,'.gemini/agy-kit') } = {}) {
    this.home = home; this.file = path.join(stateDir, 'usage-records.json'); this.cache = new Map(); this.pending = null;
  }
  async record(records) {
    // 只保存计数和模型标识，不落盘对话正文。
    let existing = [];
    try { existing = JSON.parse(await fs.promises.readFile(this.file,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('用量归档损坏，未覆盖'); }
    const rows = new Map(existing.map(r=>[r.id,r]));
    for (const r of records) {
      if (r.source === 'cli') continue;
      if (!/^[a-f\d-]{36}$/i.test(r.session) || !Number.isInteger(r.step) || r.step < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
      const clean = { id: `${r.session}:${r.step}`, session:r.session, step:r.step, source:'desktop', date:r.date, at:Number.isInteger(r.at)?r.at:undefined, model:String(r.model||'').slice(0,120), input:numeric(r.input), output:numeric(r.output), cache:numeric(r.cache), cacheCreate:numeric(r.cacheCreate) };
      const prev = rows.get(clean.id);
      if (!prev || clean.output >= prev.output) rows.set(clean.id,clean);
    }
    if (rows.size > 100000) throw new Error('用量归档达到 10 万条，请导出后再整理');
    await fs.promises.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    const temp = this.file+'.tmp'; await fs.promises.writeFile(temp,JSON.stringify([...rows.values()]),{mode:0o600}); await fs.promises.rename(temp,this.file);
  }
  async scan() {
    if (this.pending) return this.pending;
    this.pending = this.read().finally(()=>{this.pending=null;}); return this.pending;
  }
  async read() {
    const rows = new Map(), warnings = [], files=[];
    const walk = async (dir, source, base, depth=0) => {
      if (depth>8) {warnings.push('部分目录超过扫描深度'); return;}
      let entries; try { entries=await fs.promises.readdir(dir,{withFileTypes:true}); } catch(e) {if(e.code!=='ENOENT')warnings.push('部分历史目录无法读取');return;}
      for(const e of entries) {
        if(files.length>=3000){warnings.push('达到 3000 个日志扫描上限');return;}
        const full=path.join(dir,e.name);
        if(e.isDirectory()&&!['steps','scratch','chunks'].includes(e.name))await walk(full,source,base,depth+1);
        else if(e.isFile()&&e.name==='transcript.jsonl')files.push({path:full,source,session:path.relative(base,full).split(path.sep)[0]});
      }
    };
    const base=path.join(this.home,'.gemini','antigravity','brain');await walk(base,'desktop',base);
    for(const file of files) {
      const stat=await fs.promises.stat(file.path).catch(()=>null); if(!stat){warnings.push('部分日志已移动');continue;}
      const key=`${stat.size}:${stat.mtimeMs}`; let cached=this.cache.get(file.path);
      if(!cached||cached.key!==key) {
        const records=[];let line=0,bad=0;
        if(stat.size>64*1024*1024){warnings.push('跳过超过 64 MiB 的日志');continue;}
        const stream=fs.createReadStream(file.path); const reader=readline.createInterface({input:stream,crlfDelay:Infinity});
        try{for await(const text of reader){line++;if(text.length>4*1024*1024){bad++;continue;}try{const r=normalize(JSON.parse(text),{...file,line});if(r)records.push(r);}catch{if(text.trim())bad++;}}}catch{bad++;}finally{reader.close();stream.destroy();}
        cached={key,records,bad};this.cache.set(file.path,cached);if(this.cache.size>512)this.cache.delete(this.cache.keys().next().value);
      }
      if(cached.bad)warnings.push(`${cached.bad} 条日志未能解析`);
      for(const r of cached.records){const prev=rows.get(r.id);if(!prev||r.output>=prev.output)rows.set(r.id,r);}
    }
    try { const own=JSON.parse(await fs.promises.readFile(this.file,'utf8'));mergeArchive(rows,own); } catch(e){if(e.code!=='ENOENT')warnings.push('用量归档无法读取');}
    const daily = new Map(), totals={input:0,output:0,cache:0,cacheCreate:0,requests:0,usd:0,unpriced:0,unpricedTokens:0};
    const result=[...rows.values()];
    const models = new Map();
    for(const r of result) {
      const model = r.model || '模型未记录'; const group = models.get(model) || {name:model,tokens:0,requests:0};group.tokens+=r.input+r.output+r.cache+r.cacheCreate;group.requests++;models.set(model,group);
      const key=`${r.date}:${r.source}`;const day=daily.get(key)||{date:r.date,source:r.source,input:0,output:0,cache:0,cacheCreate:0,requests:0,usd:0,unpriced:0,unpricedTokens:0};
      const price=cost(r); for(const target of [day,totals]){for(const k of ['input','output','cache','cacheCreate'])target[k]+=numeric(r[k]);target.requests++;if(price.usd===null){target.unpriced++;target.unpricedTokens+=r.input+r.output+r.cache+r.cacheCreate;}else target.usd+=price.usd;}daily.set(key,day);
    }
    return {models:[...models.values()].sort((a,b)=>b.tokens-a.tokens),daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),totals,records:result.map(r=>({...r,price:cost(r)})).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,500),warnings:[...new Set(warnings)],files:files.length,scope:'仅统计本机客户端可读取的用量记录',scannedAt:Date.now()};
  }
}
module.exports={HistoryStore,normalize,dateKey,mergeArchive};
