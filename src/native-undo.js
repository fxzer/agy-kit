/* 只读取当前 React 树的撤回能力，文件与消息仍由宿主处理。 */
(function(root){
  'use strict';
  function currentFiber(element){
    let fiber=element?.[Object.keys(element).find(k=>k.startsWith('__reactFiber$'))];
    let top=fiber;while(top?.return)top=top.return;
    if(top?.stateNode?.current&&top.stateNode.current!==top)fiber=fiber?.alternate||fiber;
    return fiber;
  }
  function resolve(button){
    let state,context,session,index,text;
    for(let f=currentFiber(button),depth=0;f&&depth<65;f=f.return,depth++){
      const props=f.memoizedProps;
      if(!state&&props?.revertState)state=props.revertState;
      if(session===undefined&&typeof props?.cascadeId==='string')session=props.cascadeId;
      if(index===undefined&&Number.isInteger(props?.userStepIndex))index=props.userStepIndex;
      if(text===undefined&&Array.isArray(props?.items))text=props.items.filter(item=>item?.chunk?.case==='text').map(item=>item.chunk.value||'').join('');
      for(let d=f.dependencies?.firstContext;d;d=d.next){const value=d.memoizedValue;if(!context&&value?.stepHandler?.getRevertPreviews&&value.inputBoxRef)context=value;}
      if(state&&context&&session&&index!==undefined&&text!==undefined)break;
    }
    if(!state?.canRevert||!state.revertPreviewState?.revert||!context||!session||index===undefined)return null;
    if(text===undefined)text=button?.closest?.('[data-testid="user-input-step"]')?.querySelector?.('[data-testid="user-message-content"] [data-quotable="true"], [data-testid="user-message-content"]')?.textContent||'';
    return {state:state.revertPreviewState,context,session,index,text};
  }
  function editor(context){return context.inputBoxRef.current?.lexicalRef?.current?.getRootElement?.();}
  function hasDraft(context){return !!editor(context)?.textContent?.trim()||!!context.inputBoxRef.current?.getMediaAttachments?.().length;}
  function setText(context,text){
    const value=String(text??'');
    const ed=context?.inputBoxRef?.current?.lexicalRef?.current;
    if(ed?._nodes&&typeof ed.update==='function'){
      const ParaNode=ed._nodes.get('paragraph')?.klass,TextNode=ed._nodes.get('text')?.klass,LineBreakNode=ed._nodes.get('linebreak')?.klass;
      if(ParaNode&&TextNode){
        ed.update(()=>{
          const rootNode=ed.getEditorState()._nodeMap.get('root')?.getWritable?.();
          if(!rootNode)return;
          rootNode.clear();
          const p=new ParaNode();
          value.split(/\r?\n/).forEach((line,i)=>{
            if(i>0&&LineBreakNode)p.append(new LineBreakNode());
            if(line)p.append(new TextNode(line));
          });
          rootNode.append(p);
          p.selectEnd?.();
        },{discrete:true});
        return;
      }
    }
    const el=editor(context);if(el)el.textContent=value;
  }
  async function submit(context,composer){
    await new Promise(r=>setTimeout(r,450+Math.random()*400));
    const activeComposer=editor(context)?.closest?.('[data-testid="agent-input-box"]')||composer;
    const scope=activeComposer||(typeof document==='object'?document:null);
    const btn=scope?.querySelector?.('button[aria-label="Send message"]:not(:disabled)');
    if(btn){btn.click();return;}
    context?.inputBoxRef?.current?.submit?.();
  }
  async function perform(target){
    const handler=target.context.stepHandler,original=handler.revertToIndex;let pending;
    // 宿主回调恢复富文本和附件、更新会话；短暂捕获该次请求的结果以处理成功/失败。
    handler.revertToIndex=function(...args){const result=original.apply(this,args);if(args[0]===target.session&&args[1]===target.index-1)pending=Promise.resolve(result);return result;};
    try{target.state.revert();}finally{handler.revertToIndex=original;}
    if(!pending)throw new Error('客户端未执行撤回，请重新打开该消息。');
    await pending;
    // 等待宿主自身 revert.then() 草稿恢复回调执行完毕，避免后续覆盖写入文本。
    await new Promise(r=>setTimeout(r,0));
  }
  const ns=root[Symbol.for('agy.kit')]||root;
  const api={resolve,editor,hasDraft,setText,submit,perform};
  if(typeof module==='object'&&module.exports)module.exports=api;else ns.__AGY_KIT_NATIVE_UNDO__=api;
})(typeof window==='object'?window:globalThis);
