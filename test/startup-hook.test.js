const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('vm');const fs=require('fs');const path=require('path');
test('辅助服务失效时仍注入胶囊，后创建窗口按事件注入且无轮询定时器',async()=>{
 let fail=true,timers=0;const injected=[];const windows=[];const listeners=new Map();
 const app={
  on(event,fn){const list=listeners.get(event)||[];list.push(fn);listeners.set(event,list);},
  whenReady(){return Promise.resolve();}
 };
 const context={require(name){if(name==='fs')return {readFileSync:()=>'(function(){ /* renderer */ })();'};if(name==='path')return path;if(name==='os')return {homedir:()=>'/home/test'};if(name==='electron')return {app};if(fail)throw new Error('service unavailable');return {start:async()=>({config:{url:'local',token:'test'}})};},utils_1:{getHubWindows:()=>windows,getHubWebContents:w=>w},process:{resourcesPath:'/app'},console:{warn(){}},setInterval(){timers++;return {unref(){}};},clearInterval(){},WeakSet};
 const mkWindow=()=>{const ev=new Map();return {isDestroyed:()=>false,getURL:()=> 'https://127.0.0.1:1/c/test',on(e,fn){ev.set(e,fn);},once(e,fn){ev.set(e,fn);},emit(e){ev.get(e)?.();},isLoading:()=>false,executeJavaScript:async s=>injected.push(s)};};
 windows.push(mkWindow());
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/startup-hook.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));
 assert.equal(timers,0);assert.equal(injected.length,1);assert.match(injected[0],/BRIDGE_CONFIG__ = null/);
 fail=false;const w2=mkWindow();windows.push(w2);
 for(const fn of listeners.get('web-contents-created')||[])fn({},w2);
 w2.emit('did-finish-load');
 await new Promise(r=>setImmediate(r));
 assert.equal(injected.length,2);assert.match(injected[1],/"url":"local"/);
});
