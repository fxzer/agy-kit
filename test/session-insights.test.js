const {test}=require('node:test');
const assert=require('node:assert/strict');
const {track, classify, sources, sourceMap, squarify}=require('../src/session-insights');
function snapshot(input, checkpoint, count=3, model='m', index=7) {return {index,count,step:{status:'CORTEX_STEP_STATUS_DONE'},row:{chatModel:{model,usage:{inputTokens:String(input)},chatStartMetadata:{checkpointIndex:checkpoint}}}};}
test('只有同模型、单调步骤与新检查点共同确认时才报告压缩',()=>{
 const prev=track(null,snapshot(20000,-1)).state;
 assert.equal(track(prev,snapshot(10000,-1)).compression,null);
 assert.equal(track(prev,snapshot(10000,2,2)).compression,null);
 assert.equal(track(prev,snapshot(10000,2,4,'other')).compression,null);
 assert.equal(track(prev,snapshot(10000,2,4,'m',4)).compression,null);
 assert.equal(track(prev,snapshot(10000,2,4)).compression.released,10000);
 // 仅微幅下降（如 >5000 但不足 25%）不误报压缩
 const large=track(null,snapshot(100000,-1)).state;
 assert.equal(track(large,snapshot(92000,2,4)).compression,null);
});
test('生成中标记估算，完成后停止估算',()=>{
 const d=snapshot(1,0);d.step={status:'CORTEX_STEP_STATUS_GENERATING',metadata:{createdAt:new Date(Date.now()-1000).toISOString()},plannerResponse:{response:'hello world'}};
 assert.equal(track(null,d).liveEstimate,true);assert.ok(track(null,d).speedTps>0);
 d.step.status='CORTEX_STEP_STATUS_DONE';assert.equal(track(null,d).liveEstimate,false);
});
test('异常分类与来源排序',()=>{
 assert.equal(classify('HTTP 429'),'请求限流');assert.equal(classify('context limit exceeded'),'上下文超限');
 assert.equal(classify('quota exhausted'),'配额耗尽');assert.equal(classify('Failed to fetch'),'网络连接异常');
 assert.equal(sources({chatModel:{chatStartMetadata:{contextWindowMetadata:{tokenBreakdown:{groups:[{name:'Tools',children:[{name:'a',numTokens:1},{name:'b',numTokens:3}]}]}}}}})[0].name,'b');
});
test('上下文来源按步骤映射汉化、合并同类项并只保留占用最高的 5 项',()=>{
 const row={chatModel:{chatStartMetadata:{contextWindowMetadata:{tokenBreakdown:{groups:[
  {type:'TOKEN_TYPE_SYSTEM_PROMPT',name:'System Prompt',children:[{name:'skills',numTokens:5000},{name:'identity',numTokens:100}]},
  {type:'TOKEN_TYPE_CHAT_MESSAGES',name:'Chat Messages',children:[
   {name:'0: USER_INPUT',numTokens:200},
   {name:'1: PLANNER_RESPONSE',numTokens:4000},
   {name:'2: GENERIC',numTokens:3000},
   {name:'3: PLANNER_RESPONSE',numTokens:4500},
   {name:'4: GENERIC',numTokens:3500},
   {name:'5: GENERIC',numTokens:1200},
   {name:'6: GENERIC',numTokens:900}
  ]}
 ]}}}}};
 const stepLabels={2:'read_file · foo.js',4:'read_file · foo.js',5:'edit_file · bar.js',6:'run_command'};
 const top5=sources(row,stepLabels);
 assert.equal(top5.length,5);
 assert.deepEqual(top5[0],{group:'Chat Messages',category:'response',name:'助手回复与思考',tokens:8500,count:2});
 assert.deepEqual(top5[1],{group:'Chat Messages',category:'results',name:'读取 · foo.js',tokens:6500,count:2});
 assert.deepEqual(top5[2],{group:'System Prompt',category:'system',name:'系统 · 技能规则',tokens:5000,count:1});
 assert.equal(top5[3].name,'编辑 · bar.js');
 assert.equal(top5[4].name,'终端命令');
 const map=sourceMap(row,stepLabels);
 assert.equal(map.items.length,5);
 assert.deepEqual(map.other,{group:'Other',category:'other',name:'其余 2 项',tokens:300,count:2});
 assert.equal(map.total,22400);
});
test('每个输入框从自己的 React 树取会话，分屏无法识别时不回退到其他会话',()=>{
 const {resolveSession}=require('../src/session-insights');
 const oldDocument=global.document,oldLocation=global.location;
 global.document={querySelectorAll:()=>[{},{}]};global.location={pathname:'/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
 const footer=id=>({'__reactFiber$test':{memoizedProps:{cascadeId:id}}});
 try{
  assert.equal(resolveSession(footer('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(resolveSession(footer('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')),'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(resolveSession({}),null);
 }finally{global.document=oldDocument;global.location=oldLocation;}
});
test('Treemap squarify 矩形布局算法能够正确划分矩形且总面积守恒',()=>{
 const items = [
  { name: '助手回复', tokens: 600 },
  { name: '终端输出', tokens: 300 },
  { name: '其余项', tokens: 100 }
 ];
 const rects = squarify(items, 300, 100);
 assert.equal(rects.length, 3);
 const totalArea = rects.reduce((acc, r) => acc + (r.rect.w * r.rect.h), 0);
 assert.ok(Math.abs(totalArea - 30000) < 1e-4);
 assert.equal(squarify([], 100, 100).length, 0);
});
