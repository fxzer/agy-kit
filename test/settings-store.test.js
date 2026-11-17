const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');const settings=require('../src/settings-store');
test('设置独立于客户端端口保存在私有文件，新进程读取同一开关',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'settings.json');
 assert.equal(settings.read(file),null);settings.write({modules:{inlineUndo:true,capsule:false}},file);assert.deepEqual(settings.read(file),{modules:{inlineUndo:true,capsule:false}});assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.throws(()=>settings.write({modules:{inlineUndo:'true'}},file),/非布尔值/);assert.throws(()=>settings.write({modules:{unknown:true}},file),/未知开关/);assert.equal(settings.read(file).modules.inlineUndo,true);
});
test('本地配置优先于旧网页存储，快速切换按顺序保存最后状态',async()=>{
 const vm=require('vm'),calls=[];
 const window={__AGY_KIT_BRIDGE_CONFIG__:{settings:{modules:{inlineUndo:true}}},__AGY_KIT_BRIDGE_CLIENT__:{async call(route,value){assert.equal(route,'/settings');calls.push(value.modules.inlineUndo);}}};
 const document={querySelector(){return null;},createElement(){return {};},head:{appendChild(){}}};const localStorage={getItem(){return JSON.stringify({modules:{inlineUndo:false}});},setItem(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/config-style'),'utf8'),{window,document,localStorage,console});
 const store=window.__AGY_KIT_STORE__;assert.equal(store.config.modules.inlineUndo,true);store.setModule('inlineUndo',false);store.setModule('inlineUndo',true);await store.persisting;assert.deepEqual(calls,[true,false,true]);
});
test('渲染载荷把内部模块收敛在 Symbol 中，重复热载入不会销毁新的归档客户端',async()=>{
 const vm=require('vm'),source=require('../src/renderer-source')();
 const noop=()=>{};const doc={querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{},setAttribute:noop,appendChild:noop,remove:noop}),head:{appendChild:noop},body:{},addEventListener:noop,removeEventListener:noop,hidden:true};
 const win={__AGY_KIT_BRIDGE_CONFIG__:{url:'http://127.0.0.1:1',token:'t',settings:{modules:{capsule:false}}},addEventListener:noop,removeEventListener:noop,innerWidth:1200,innerHeight:800};
 const context=vm.createContext({window:win,document:doc,localStorage:{getItem:()=>null,setItem:noop},location:{pathname:'/',href:'https://127.0.0.1:1/'},MutationObserver:class{observe(){}disconnect(){}},AbortController,URL,Date,console,setTimeout,clearTimeout,fetch:async()=>({ok:true,json:async()=>({})})});
 vm.runInContext(source,context);
 const leaked=Object.keys(win).filter(k=>k.startsWith('__AGY_'));
 assert.deepEqual(leaked,[]);
 assert.ok(win[Symbol.for('agy.kit')]?.instance);
 vm.runInContext(source,context);
 await win[Symbol.for('agy.kit')].bridgeClient.record('s',[],[]);
 win[Symbol.for('agy.kit')].instance.destroy();
});
