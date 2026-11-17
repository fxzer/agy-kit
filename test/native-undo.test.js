const {test}=require('node:test');const assert=require('node:assert/strict');
const {perform,resolve,hasDraft,setText,submit}=require('../src/native-undo');

test('原生回滚使用原有参数和 this，等待该次请求并立即恢复方法',async()=>{
  let finish,calls=0;const handler={revertToIndex(id,index,options){assert.equal(this,handler);assert.equal(id,'session');assert.equal(index,3);assert.deepEqual(options,{conversationOnly:true});calls++;return new Promise(r=>{finish=r;});}};
  const original=handler.revertToIndex;let done=false;
  const pending=perform({session:'session',index:4,context:{stepHandler:handler},state:{revert(){handler.revertToIndex('session',3,{conversationOnly:true}).catch(()=>{});}}}).then(()=>{done=true;});
  assert.equal(handler.revertToIndex,original);assert.equal(done,false);assert.equal(calls,1);finish();await pending;assert.equal(done,true);
});

test('原生回滚失败或同步抛错后仍恢复方法，不伪报成功',async()=>{
  const handler={revertToIndex(){return Promise.reject(new Error('network failed'));}};const original=handler.revertToIndex;
  const target={session:'s',index:0,context:{stepHandler:handler},state:{revert(){handler.revertToIndex('s',-1,{}).catch(()=>{});}}};
  await assert.rejects(perform(target),/network failed/);assert.equal(handler.revertToIndex,original);
  target.state.revert=()=>{throw new Error('sync failed');};await assert.rejects(perform(target),/sync failed/);assert.equal(handler.revertToIndex,original);
  target.state.revert=()=>{};await assert.rejects(perform(target),/未执行撤回/);
});

test('读取当前 React 分支并提取气泡提示词文本（items 优先，DOM 兜底）',()=>{
  const context={stepHandler:{getRevertPreviews(){}},inputBoxRef:{current:null}};
  const state={canRevert:true,revertPreviewState:{revert(){},conversationOnly:true}};
  const rootA={},rootB={};const host={current:rootB};rootA.stateNode=rootB.stateNode=host;
  const old={return:rootA,memoizedProps:{revertState:{canRevert:false}}};
  const items=[{chunk:{case:'text',value:'第一段'}},{chunk:{case:'other',value:'ignored'}},{chunk:{case:'text',value:'第二段'}}];
  const live={return:rootB,memoizedProps:{revertState:state,cascadeId:'s',userStepIndex:0,items},dependencies:{firstContext:{memoizedValue:context}}};old.alternate=live;
  const result=resolve({'__reactFiber$test':old});
  assert.equal(result.session,'s');assert.equal(result.index,0);assert.equal(result.state.conversationOnly,true);
  assert.equal(result.text,'第一段第二段');
  delete live.memoizedProps.items;
  const fallbackBtn={'__reactFiber$test':old,closest:()=>({querySelector:()=>({textContent:'DOM兜底文本'})})};
  assert.equal(resolve(fallbackBtn).text,'DOM兜底文本');
  state.canRevert=false;assert.equal(resolve({'__reactFiber$test':old}),null);
});

test('文字草稿与仅附件草稿均阻止覆盖，空白不算草稿',()=>{
  const node={textContent:'  '};let media=[];const context={inputBoxRef:{current:{lexicalRef:{current:{getRootElement:()=>node}},getMediaAttachments:()=>media}}};
  assert.equal(hasDraft(context),false);media=[{}];assert.equal(hasDraft(context),true);media=[];node.textContent='draft';assert.equal(hasDraft(context),true);
});

test('setText 支持多行写入 Lexical 节点，submit 触发发送按钮',async()=>{
  const appended=[];
  class Para{constructor(){this.children=[];}append(c){this.children.push(c);}selectEnd(){this.selected=true;}}
  class Text{constructor(v){this.text=v;}}
  class LineBreak{}
  const rootNode={cleared:false,clear(){this.cleared=true;},append(c){appended.push(c);}};
  const ed={
    _nodes:new Map([['paragraph',{klass:Para}],['text',{klass:Text}],['linebreak',{klass:LineBreak}]]),
    getEditorState(){return {_nodeMap:new Map([['root',{getWritable:()=>rootNode}]])};},
    update(fn,opts){assert.equal(opts.discrete,true);fn();}
  };
  let clicked=0;
  const composer={querySelector:(s)=>s.includes('Send message')?{click(){clicked++;}}:null};
  const ctx={inputBoxRef:{current:{lexicalRef:{current:ed}}}};
  setText(ctx,'line1\nline2');
  assert.equal(rootNode.cleared,true);
  assert.equal(appended.length,1);
  assert.equal(appended[0].children.length,3);
  assert.equal(appended[0].children[0].text,'line1');
  assert.ok(appended[0].children[1] instanceof LineBreak);
  assert.equal(appended[0].children[2].text,'line2');
  assert.equal(appended[0].selected,true);
  await submit(ctx,composer);
  assert.equal(clicked,1);
});

test('增强模块重复启用不重复监听，关闭后释放观察器和所有监听',()=>{
  const vm=require('vm'),fs=require('fs');const listeners=new Set();let observing=0,styles=0;
  const surface=name=>({addEventListener(type,fn,capture){listeners.add(name+type+!!capture);},removeEventListener(type,fn,capture){listeners.delete(name+type+!!capture);}});
  const document={...surface('doc'),head:{appendChild(){styles++;}},createElement(){return{remove(){styles--;}};}};
  const window={...surface('win'),__AGY_KIT_NATIVE_UNDO__:{}};
  const context={window,document,clearTimeout,setTimeout,MutationObserver:class{observe(){observing++;}disconnect(){observing--;}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/inline-undo'),'utf8'),context);
  const feature=new window.__AGY_KIT_INLINE_UNDO__();feature.mount();feature.mount();
  assert.equal(listeners.size,2);assert.equal(observing,0);assert.equal(styles,1);
  feature.unmount();feature.unmount();
  assert.equal(listeners.size,0);assert.equal(observing,0);assert.equal(styles,0);
});

function createInlineEnv(){
  const vm=require('vm'),fs=require('fs');
  const makeClassList=(initial=[])=>{
    const set=new Set(initial);
    return {
      add(c){set.add(c);},
      remove(c){set.delete(c);},
      contains(c){return set.has(c);}
    };
  };
  let sendClicks=0,focusedBottom=0,scrolledBottom=0,performCalls=0,writtenText=null,submitted=0;
  const bottomComposer={style:{position:'static'},scrollIntoView(){scrolledBottom++;}};
  const bottomInput={focus(){focusedBottom++;},closest:()=>bottomComposer};
  const contentEl={hidden:false,classList:makeClassList(),textContent:'原始提示词'};
  let appendedEditor=null;
  const bubble={
    isConnected:true,
    classList:makeClassList(),
    parentElement:null,
    querySelector(sel){return sel==='[data-testid="user-message-content"]'?contentEl:null;},
    appendChild(node){appendedEditor=node;node.isConnected=true;}
  };
  const frame={classList:makeClassList(['agy-user-bubble-frame']),parentElement:null};
  const maxBox={classList:makeClassList(['max-w-[80%]']),parentElement:null};
  const stepEl={
    querySelector(sel){return sel==='[data-testid="user-message-bubble"]'?bubble:null;}
  };
  bubble.parentElement=frame;frame.parentElement=maxBox;maxBox.parentElement=stepEl;
  const revertButton={
    disabled:false,
    getAttribute(){return null;},
    focus(){},
    isConnected:true,
    closest(sel){return sel==='[data-testid="user-input-step"]'?stepEl:null;}
  };
  const target={
    session:'s1',
    index:1,
    text:'原始提示词',
    state:{conversationOnly:false,conversationOnlyRevertEnabled:true,setConversationOnly(v){this.conversationOnly=v;}},
    context:{stepHandler:{async getRevertPreviews(){return [];}},inputBoxRef:{current:{}}}
  };

  function makeEditorNode(){
    const el={
      className:'',
      style:{},
      attributes:{},
      children:{},
      listeners:{},
      setAttribute(k,v){this.attributes[k]=v;},
      addEventListener(type,fn){this.listeners[type]=fn;},
      remove(){this.isConnected=false;appendedEditor=null;},
      set innerHTML(html){
        const ta={
          value:'',style:{},scrollHeight:80,disabled:false,listeners:{},
          addEventListener(type,fn){this.listeners[type]=fn;},
          focus(){},setSelectionRange(){}
        };
        const mkBtn=()=>({disabled:false,onclick:null,addEventListener(){}});
        this._nodes={
          '.agy-inline-textarea':ta,
          '[data-meta]':{innerHTML:'',querySelector:()=>null},
          '[data-files]':{innerHTML:''},
          '[data-status]':{textContent:''},
          '[data-cancel]':mkBtn(),
          '[data-bottom]':mkBtn(),
          '[data-send]':mkBtn()
        };
      },
      querySelector(sel){return this._nodes?.[sel]||null;},
      querySelectorAll(sel){return sel==='button'?[this._nodes['[data-cancel]'],this._nodes['[data-bottom]'],this._nodes['[data-send]']]:[];}
    };
    return el;
  }

  const document={
    body:{},
    head:{appendChild(){}},
    addEventListener(){},removeEventListener(){},
    createElement(tag){
      if(tag==='style')return {textContent:'',remove(){}};
      return makeEditorNode();
    }
  };
  const window={
    __AGY_KIT_NATIVE_UNDO__:{
      resolve:()=>target,
      editor:()=>bottomInput,
      hasDraft:()=>false,
      setText:(ctx,txt)=>{writtenText=txt;},
      async perform(){performCalls++;},
      async submit(){submitted++;}
    }
  };
  const context={window,document,clearTimeout,setTimeout,MutationObserver:class{observe(){}disconnect(){}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/inline-undo'),'utf8'),context);
  const feature=new window.__AGY_KIT_INLINE_UNDO__();
  feature.mount();
  return {
    feature,revertButton,bubble,frame,maxBox,contentEl,bottomComposer,
    getEditor:()=>appendedEditor,
    getStats:()=>({sendClicks,focusedBottom,scrolledBottom,performCalls,writtenText,submitted})
  };
}

test('点击撤回按钮后气泡原地变为输入框，底部输入框保持不变，取消恢复原气泡',async()=>{
  const env=createInlineEnv();
  await env.feature.openInline(env.revertButton,{...env.feature,session:'s1',index:1,text:'原始提示词',state:{conversationOnly:false,conversationOnlyRevertEnabled:true,setConversationOnly(){}},context:{stepHandler:{async getRevertPreviews(){return [];}}}});
  const editor=env.getEditor();
  assert.ok(editor,'应在气泡内创建原地编辑框');
  assert.equal(env.contentEl.hidden,true,'原只读提示词文本应隐藏');
  assert.equal(env.contentEl.classList.contains('agy-inline-hidden'),true);
  assert.equal(env.bubble.classList.contains('agy-bubble-editing-host'),true);
  assert.equal(env.frame.classList.contains('agy-bubble-editing-host'),true);
  assert.equal(env.bottomComposer.style.position,'static','底部输入框样式不应被篡改或隐藏');

  const ta=editor.querySelector('.agy-inline-textarea');
  assert.equal(ta.value,'原始提示词');
  editor.querySelector('[data-cancel]').onclick();
  assert.equal(env.getEditor(),null,'取消后应移除原地编辑框');
  assert.equal(env.contentEl.hidden,false,'取消后应恢复原提示词气泡文本');
  assert.equal(env.contentEl.classList.contains('agy-inline-hidden'),false);
  assert.equal(env.getStats().performCalls,0,'取消不应执行撤回');
});

test('点击回到底部编辑执行撤回并把修改文本写入底部输入框，点击发送执行撤回并提交',async()=>{
  const env1=createInlineEnv();
  env1.feature.onClick({target:{closest:()=>env1.revertButton},preventDefault(){},stopImmediatePropagation(){}});
  await new Promise(r=>setTimeout(r,10));
  const ed1=env1.getEditor(),ta1=ed1.querySelector('.agy-inline-textarea');
  ta1.value='改写后去底部';ta1.listeners.input();
  await ed1.querySelector('[data-bottom]').onclick();
  assert.equal(env1.getStats().performCalls,1);
  assert.equal(env1.getStats().writtenText,'改写后去底部');
  assert.equal(env1.getStats().submitted,0);
  assert.equal(env1.getStats().focusedBottom,1);
  assert.equal(env1.getStats().scrolledBottom,1);
  assert.equal(env1.getEditor(),null);

  const env2=createInlineEnv();
  env2.feature.onClick({target:{closest:()=>env2.revertButton},preventDefault(){},stopImmediatePropagation(){}});
  await new Promise(r=>setTimeout(r,10));
  const ed2=env2.getEditor(),ta2=ed2.querySelector('.agy-inline-textarea');
  ta2.value='原地改完直接发';ta2.listeners.input();
  await ed2.querySelector('[data-send]').onclick();
  assert.equal(env2.getStats().performCalls,1);
  assert.equal(env2.getStats().writtenText,'原地改完直接发');
  assert.equal(env2.getStats().submitted,1);
  assert.equal(env2.getEditor(),null);
});
test('仅撤回会话时不预发预览请求，切换为撤回文件时才按需加载',async()=>{
  const env=createInlineEnv();
  let previewCalls=0;
  const target={
    session:'s1',index:1,text:'测试',
    state:{conversationOnly:true,conversationOnlyRevertEnabled:true,setConversationOnly(v){this.conversationOnly=v;}},
    context:{stepHandler:{async getRevertPreviews(){previewCalls++;return [{uri:'file:///a.js'}];}},inputBoxRef:{current:{}}}
  };
  await env.feature.openInline(env.revertButton,target);
  assert.equal(previewCalls,0);
});
