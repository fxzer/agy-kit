const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const os=require('os');const {start}=require('../src/backend-service');
test('本地服务拒绝无令牌与非客户端来源，仅返回统计数据',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agy-backend-'));const service=await start({home,publish:false});t.after(async()=>{await service.close();fs.rmSync(home,{recursive:true,force:true});});
 const url=service.config.url;const post=(route,origin,token,data={})=>fetch(url+route,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post('/history','https://example.com',service.config.token)).status,403);
 assert.equal((await post('/history','https://127.0.0.1:1234','wrong')).status,403);
 const response=await post('/history','https://127.0.0.1:1234',service.config.token);assert.equal(response.status,200);assert.equal((await response.json()).totals.requests,0);
 const health=await (await post('/health','https://127.0.0.1:1234',service.config.token)).json();assert.match(health.build,/^[a-f\d]{64}$/);
 assert.equal((await post('/settings','https://127.0.0.1:1234','wrong',{modules:{inlineUndo:true}})).status,403);
 assert.equal((await post('/settings','https://127.0.0.1:1234',service.config.token,{modules:{inlineUndo:true}})).status,200);
 assert.equal(JSON.parse(JSON.stringify(service.config)).settings.modules.inlineUndo,true);
 assert.equal((await post('/settings','https://127.0.0.1:1234',service.config.token,{modules:{inlineUndo:'yes'}})).status,400);
 assert.equal((await (await post('/settings','https://127.0.0.1:1234',service.config.token)).json()).modules.inlineUndo,true);
 assert.equal((await post('/record','https://127.0.0.1:1234',service.config.token,{records:'no'})).status,400);
});
