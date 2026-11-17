const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');
const {HistoryStore}=require('../src/history-store');
test('历史按会话步骤去重，排除 CLI 日志与旧归档',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agy-history-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const session='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';const dir=path.join(home,'.gemini/antigravity/brain',session,'.system_generated/logs');fs.mkdirSync(dir,{recursive:true});
 const event={step_index:1,created_at:'2026-11-15T10:00:00Z',input_tokens:100,output_tokens:20,cache_read_tokens:50};
 fs.writeFileSync(path.join(dir,'transcript.jsonl'),[event,event,{...event,step_index:2}].map(JSON.stringify).join('\n'));
 const cli=path.join(home,'.gemini/antigravity-cli/brain/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'transcript.jsonl'),JSON.stringify({...event,model:'unknown'}));
 const store=new HistoryStore({home});await store.record([{session,step:1,date:'2026-11-15',source:'desktop',model:'Gemini 3.8 Flash (High)',input:100,output:20,cache:50,cacheCreate:0}]);
 const saved=JSON.parse(fs.readFileSync(store.file));saved.push({id:'legacy-cli',source:'cli',date:'2026-11-15',input:9999,output:1,cache:0,cacheCreate:0});fs.writeFileSync(store.file,JSON.stringify(saved));
 const result=await store.scan();assert.equal(result.totals.requests,2);assert.equal(result.totals.input,200);assert.equal(result.daily.some(d=>d.source==='cli'),false);assert.equal(result.models.reduce((n,m)=>n+m.tokens,0),340);
 assert.equal(fs.statSync(store.file).mode&0o777,0o600);
 fs.writeFileSync(store.file,'broken');await assert.rejects(store.record([]),/损坏/);assert.equal(fs.readFileSync(store.file,'utf8'),'broken');
});

test('模型聚合覆盖全部用量而非最近 500 条',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agy-models-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const store=new HistoryStore({home});await store.record(Array.from({length:600},(_,step)=>({session:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',step,date:'2026-11-15',model:step<100?'old':'new',input:10,output:1})));
 const data=await store.scan();assert.equal(data.records.length,500);assert.equal(data.totals.requests,600);assert.equal(data.models.find(m=>m.name==='old').tokens,1100);assert.equal(data.models.find(m=>m.name==='new').tokens,5500);
});
test('服务端与旧日志步骤编号不同且互相碰撞时，不重复累加',()=>{
 const {mergeArchive}=require('../src/history-store');
 const base={session:'s',source:'desktop',date:'2026-11-15',cache:0,cacheCreate:0};
 const logs=[{...base,id:'s:1',step:1,input:100,output:20},{...base,id:'s:2',step:2,input:200,output:40},{...base,id:'s:3',step:3,input:100,output:20}];
 const map=new Map(logs.map(r=>[r.id,r]));
 mergeArchive(map,[{...logs[0],id:'s:2',step:2,model:'known'},{...logs[1],id:'s:4',step:4},{...logs[2],id:'s:6',step:6}]);
 assert.equal(map.size,3);assert.equal([...map.values()].reduce((n,r)=>n+r.input+r.output,0),480);assert.equal(map.get('s:1').model,'known');
});
test('同秒用量更新配对，真正新增请求和相同用量的多个请求保留',()=>{
 const {mergeArchive}=require('../src/history-store');
 const r={id:'s:1',session:'s',step:1,source:'desktop',date:'2026-11-15',at:100,input:100,output:1,cache:0,cacheCreate:0};
 const map=new Map([[r.id,r]]);mergeArchive(map,[{...r,id:'s:2',step:2,output:10},{...r,id:'s:4',step:4,at:101,output:10}]);
 assert.equal(map.size,2);assert.equal(map.get('s:1').output,10);
 const repeated=new Map([[r.id,r]]);mergeArchive(repeated,[{...r,id:'s:2',step:2},{...r,id:'s:3',step:3,at:101}]);assert.equal(repeated.size,2);
 const olderOutput=new Map([[r.id,{...r,output:50}]]);mergeArchive(olderOutput,[{...r,id:'s:2',step:2,output:10,model:'Gemini 4 Hydrogen (High)'}]);assert.equal(olderOutput.get('s:1').output,50);assert.equal(olderOutput.get('s:1').model,'Gemini 4 Hydrogen (High)');
});
