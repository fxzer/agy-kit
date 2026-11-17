const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('vm');const fs=require('fs');const {getEventListeners}=require('node:events');
function setup(){
 const portals=[];const document=new EventTarget();document.activeElement=null;
 document.body={appendChild(tip){portals.push(tip);}};
 document.createElement=()=>({style:{},setAttribute(){},getBoundingClientRect:()=>({width:320,height:170}),remove(){const i=portals.indexOf(this);if(i>=0)portals.splice(i,1);}});
 const window=new EventTarget();window.__AGY_KIT_USAGE__=require('../src/usage-summary');
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/reports-panel'),'utf8'),{window,document,innerWidth:1024,innerHeight:768,AbortController,URL,Date});
 const panel=new window.__AGY_KIT_REPORTS_PANEL__({});
 const attributes=new Map();const cell={dataset:{heatmapDay:'2026-11-06'},style:{},setAttribute(k,v){attributes.set(k,v);},removeAttribute(k){attributes.delete(k);},getBoundingClientRect:()=>({left:995,top:12,width:18,bottom:30})};
 return {panel,cell,attributes,portals,window,document};
}
test('悬浮卡显示本地日期、准确总量与四类用量，零活动日也可查看',()=>{
 const {panel,cell,attributes,portals}=setup();panel.showUsageTip(cell,{tokens:19096000,requests:15,input:96000,output:1000000,cache:18000000,cacheCreate:0});
 const html=panel.usageTip.innerHTML;assert.match(html,/2026年11月6日/);assert.match(html,/19.1M Token · 15 次请求/);assert.match(html,/合计 19.1M Token/);
 for(const label of ['输入','输出','缓存读取','缓存写入'])assert.ok(html.includes(label));assert.equal(attributes.get('aria-describedby'),'agy-kit-usage-tooltip');
 panel.showUsageTip(cell,{});assert.match(panel.usageTip.innerHTML,/0 Token · 0 次请求/);assert.equal(portals.length,1);
 panel.hideUsageTip();assert.equal(portals.length,0);assert.equal(attributes.has('aria-describedby'),false);
});
test('右上角方格的悬浮卡保持在窗口内，不被裁出屏幕',()=>{
 const {panel,cell}=setup();panel.showUsageTip(cell,{});const style=panel.usageTip.style,left=parseFloat(style.left),top=parseFloat(style.top);
 assert.ok(left>=12&&left+320<=1024-12);assert.ok(top>=12&&top+170<=768-12);assert.ok(top>=cell.getBoundingClientRect().bottom);
});
test('滚动关闭悬浮卡，切页/销毁释放全局事件与浮层',()=>{
 const {panel,cell,window,document,portals}=setup();const host=new EventTarget(),grid=new EventTarget();panel.bindHeatmap(host,grid,new Map());
 assert.equal(getEventListeners(window,'scroll').length,1);assert.equal(getEventListeners(document,'pointerdown').length,1);
 panel.showUsageTip(cell,{});window.dispatchEvent(new Event('scroll'));assert.equal(portals.length,0);
 panel.showUsageTip(cell,{});panel.destroy();assert.equal(portals.length,0);assert.equal(getEventListeners(window,'scroll').length,0);assert.equal(getEventListeners(window,'resize').length,0);assert.equal(getEventListeners(document,'pointerdown').length,0);
});
test('趋势曲线经过每日用量点、连接处切线连续且不超出相邻用量范围',()=>{
 for(const values of [[0,0,100,101,30,20,0],Array(7).fill(1),Array(30).fill(0),Array.from({length:30},(_,i)=>i%2?100:1)]){
  const {panel}=setup(),host={innerHTML:''};panel.root={querySelector:()=>({querySelector:()=>host})};panel.range=values.length;
  const now=new Date();now.setHours(12,0,0,0);const {dateKey}=require('../src/usage-summary');
  panel.data={daily:values.map((input,i)=>{const d=new Date(now);d.setDate(d.getDate()-values.length+1+i);return {date:dateKey(d),input,output:0,cache:0,cacheCreate:0,requests:input?1:0};})};
  panel.bindTrend=()=>{};panel.drawTrend();
  const path=host.innerHTML.match(/ d="([^"]+)"/)[1],nums=path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
  assert.equal(nums.length,2+6*(values.length-1));assert.ok(!host.innerHTML.includes('<polyline'));
  const max=Math.max(1,...values);let x=nums[0],y=nums[1],previousSlope;
  assert.equal(y,144-values[0]/max*128);
  for(let i=2,j=1;i<nums.length;i+=6,j++){
   const [ax,ay,bx,by,ex,ey]=nums.slice(i,i+6),low=Math.min(y,ey),high=Math.max(y,ey);
   assert.ok(Math.abs(ey-(144-values[j]/max*128))<1e-9);
   if(previousSlope!==undefined)assert.ok(Math.abs((ay-y)/(ax-x)-previousSlope)<1e-9);
   for(let t=0;t<=1;t+=.05){const v=(1-t)**3*y+3*(1-t)**2*t*ay+3*(1-t)*t*t*by+t**3*ey;assert.ok(v>=low-1e-9&&v<=high+1e-9);}
   previousSlope=(ey-by)/(ex-bx);x=ex;y=ey;
  }
  assert.equal((host.innerHTML.match(/data-trend-day=/g)||[]).length,values.length);
  if(values.every(v=>v===1))assert.match(host.innerHTML,/峰值 1 Token/);
 }
});
test('趋势点悬浮显示当天明细、突出数据点和辅助线，离开及销毁清理',()=>{
 const {panel,cell,window,document,portals}=setup(),host=new EventTarget();cell.dataset={trendDay:'2026-11-06'};
 const heatmap=new EventTarget();heatmap.contains=()=>false;panel.bindHeatmap(heatmap,new EventTarget(),new Map());
 const dot=new Map(),guide=new Map();cell.querySelector=s=>({setAttribute:(k,v)=>(s.includes('dot')?dot:guide).set(k,v),getBoundingClientRect:cell.getBoundingClientRect});
 cell.closest=()=>cell;cell.contains=t=>t===cell;host.contains=t=>t===cell;
 panel.bindTrend(host,new Map([['2026-11-06',{tokens:19096000,requests:15,input:96000,output:1000000,cache:18000000}]]));
 function fire(type){const e=new Event(type);Object.defineProperty(e,'target',{value:cell});Object.defineProperty(e,'relatedTarget',{value:null});host.dispatchEvent(e);}
 fire('pointerover');assert.match(panel.usageTip.innerHTML,/19.1M Token · 15 次请求/);assert.match(panel.usageTip.innerHTML,/96K/);
 assert.equal(dot.get('r'),'5.5');assert.equal(guide.get('opacity'),'.45');
 const hostDown=new Event('pointerdown',{cancelable:true});Object.defineProperty(hostDown,'target',{value:cell});host.dispatchEvent(hostDown);assert.equal(hostDown.defaultPrevented,true);assert.equal(portals.length,1);
 const click=new Event('pointerdown');Object.defineProperty(click,'target',{value:cell});document.dispatchEvent(click);assert.equal(portals.length,1);
 fire('pointerout');assert.equal(portals.length,0);assert.equal(dot.get('r'),'4');assert.equal(guide.get('opacity'),'0');
 fire('focusin');assert.equal(portals.length,1);window.dispatchEvent(new Event('scroll'));assert.equal(portals.length,0);
 fire('focusin');panel.destroy();assert.equal(portals.length,0);assert.equal(getEventListeners(host,'pointerover').length,0);assert.equal(getEventListeners(host,'pointerdown').length,0);assert.equal(getEventListeners(window,'scroll').length,0);assert.equal(getEventListeners(document,'pointerdown').length,0);
});
test('模型环图分段完整覆盖总量，颜色对应图例，合并其他模型不丢用量',()=>{
 const {panel}=setup();panel.data={models:Array.from({length:10},(_,i)=>({name:'模型 '+i,tokens:(10-i)*1000000}))};
 const html=panel.renderModels(),segments=[...html.matchAll(/stroke="([^"]+)" stroke-width="24" stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/g)];
 assert.equal(segments.length,8);assert.match(html,/合计 55,000,000 Token/);assert.match(html,/>55M<\/text>/);assert.match(html,/其他模型/);assert.match(html,/6M Token/);
 let offset=0;for(const [,color,length,gap,start] of segments){assert.ok(Math.abs(Number(start)+offset)<1e-8);offset+=Number(length);assert.ok(Math.abs(Number(length)+Number(gap)-2*Math.PI*80)<1e-8);assert.ok(html.includes('background:'+color));}
 assert.ok(Math.abs(offset-2*Math.PI*80)<1e-8);assert.equal((html.match(/role="listitem"/g)||[]).length,8);assert.equal(panel.data.models.length,10);
});
test('模型环图正确显示空数据、单模型整圆、极小占比与转义模型名',()=>{
 const {panel}=setup();panel.data={models:[{name:'零用量',tokens:0}]};assert.match(panel.renderModels(),/暂无模型用量/);assert.ok(!panel.renderModels().includes('<svg'));
 panel.data.models=[{name:'<img onerror="x">',tokens:1000000}];let html=panel.renderModels();assert.match(html,/100%/);assert.ok(!html.includes('<img'));assert.ok(html.includes('&#60;img'));
 const length=Number(html.match(/stroke-dasharray="([\d.]+) 0"/)[1]);assert.equal(length,2*Math.PI*80);
 panel.data.models.push({name:'极小用量',tokens:1});html=panel.renderModels();assert.match(html,/&lt;0.1%/);assert.match(html,/合计 1,000,001 Token/);
});
