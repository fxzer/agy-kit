(function(){
  'use strict';
  const ns=window[Symbol.for('agy.kit')]||window;
  const native=ns.__AGY_KIT_NATIVE_UNDO__||window.__AGY_KIT_NATIVE_UNDO__;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
  const css=`
    .agy-user-bubble-frame.agy-bubble-editing-host{box-shadow:0 0 0 1px color-mix(in srgb,var(--primary,var(--cta,#007acc)) 45%,transparent),var(--glass-shadow,0 6px 18px rgba(0,0,0,.12))}
    .agy-inline-hidden{display:none !important}
    .agy-inline-editor{display:flex;flex-direction:column;gap:8px;width:clamp(340px,50vw,580px);max-width:100%;padding:2px 4px;box-sizing:border-box;font:inherit;line-height:1.5;color:var(--foreground)}
    .agy-inline-textarea,.agy-inline-textarea:focus,.agy-inline-textarea:focus-visible{width:100%;min-height:24px;max-height:240px;resize:none;overflow-y:auto;background:transparent !important;border:0 !important;outline:none !important;box-shadow:none !important;--tw-ring-shadow:0 0 #0000 !important;--tw-ring-offset-shadow:0 0 #0000 !important;color:var(--foreground);font:inherit;line-height:1.5;padding:2px;box-sizing:border-box;margin:0}
    .agy-inline-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--border,rgba(120,120,128,.2))}
    .agy-inline-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:0.75rem;color:var(--muted-foreground)}
    .agy-inline-switch{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
    .agy-inline-editor [role=switch]{width:28px;height:16px;padding:0;border:0;border-radius:9999px;flex-shrink:0;position:relative;cursor:pointer;transition:background-color .15s ease}
    .agy-inline-editor [role=switch] span{position:absolute;top:2px;width:12px;height:12px;background:var(--primary-foreground,var(--cta-foreground,#fff));box-shadow:0 1px 2px rgb(0 0 0 / 0.18);border-radius:50%;transition:left .15s ease}
    .agy-inline-status{font-size:0.75rem;color:var(--warning,#f59e0b)}
    .agy-inline-status:empty{display:none}
    .agy-inline-btns{display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0}
    .agy-inline-btns button{cursor:pointer;border:0;border-radius:9999px;padding:0 10px;height:1.625rem;background:var(--secondary,rgba(120,120,128,.15));color:var(--foreground);font-size:0.75rem;font-weight:500;display:inline-flex;align-items:center;transition:opacity .15s ease,background-color .15s ease}
    .agy-inline-btns button:hover:not(:disabled){opacity:.88}
    .agy-inline-btns button:disabled{opacity:.45;cursor:default}
    .agy-inline-btns button:focus-visible,.agy-inline-editor [role=switch]:focus-visible{outline:2px solid var(--primary,var(--cta,#007acc));outline-offset:2px}
    .agy-inline-btns [data-send]{background:var(--primary,var(--cta,#007acc));color:var(--primary-foreground,var(--cta-foreground,#fff));padding:0 12px}
    .agy-inline-files{font-size:0.75rem;color:var(--muted-foreground)}
    .agy-inline-files:empty{display:none}
    .agy-inline-files details{padding-top:2px}
    .agy-inline-files summary{cursor:pointer;user-select:none}
  `;
  class InlineUndo{
    constructor(){this.onClick=this.onClick.bind(this);this.onKey=this.onKey.bind(this);this.check=this.check.bind(this);}
    mount(){
      if(this.mounted)return;this.mounted=true;
      this.style=document.createElement('style');this.style.textContent=css;document.head.appendChild(this.style);
      document.addEventListener('click',this.onClick,true);
      document.addEventListener('keydown',this.onKey,true);
    }
    onClick(event){
      const button=event.target?.closest?.('button[data-testid="revert-button"]');
      if(!button)return;
      if(button.disabled||button.getAttribute('aria-disabled')==='true')return;
      const target=native.resolve(button);if(!target)return;
      event.preventDefault();event.stopImmediatePropagation();
      if(this.busy)return;
      if(this.editing?.button===button){this.stopEditing(true);return;}
      this.stopEditing(false);
      this.openInline(button,target);
    }
    onKey(event){
      if(event.key==='Escape'&&this.editing&&!this.busy){
        event.preventDefault();event.stopImmediatePropagation();
        this.stopEditing(true);
      }
    }
    async openInline(button,target){
      const stepEl=button.closest?.('[data-testid="user-input-step"]');
      const bubble=stepEl?.querySelector?.('[data-testid="user-message-bubble"]')||button.parentElement;
      if(!bubble)return;
      const contentEl=bubble.querySelector?.('[data-testid="user-message-content"]')||null;
      const hosts=[bubble];
      for(let el=bubble.parentElement;el&&el!==stepEl;el=el.parentElement){
        if(el.classList?.contains('agy-user-bubble-frame')||String(el.className||'').includes('max-w-'))hosts.push(el);
      }
      for(const h of hosts)h.classList?.add('agy-bubble-editing-host');
      if(contentEl){contentEl.hidden=true;contentEl.classList?.add('agy-inline-hidden');}

      const editorBox=document.createElement('div');
      editorBox.className='agy-inline-editor';
      editorBox.setAttribute('role','region');
      editorBox.setAttribute('aria-label','原地编辑提示词');
      editorBox.addEventListener('click',e=>e.stopPropagation());

      const state={
        button,target,bubble,contentEl,hosts,editorBox,
        draftText:target.text||'',
        conversationOnly:!!target.state?.conversationOnly,
        preview:target.state?.conversationOnly?[]:null,previewError:'',previewLoaded:!target.state?.conversationOnly
      };
      this.editing=state;
      bubble.appendChild(editorBox);
      this.renderEditor(state,true);

      this.observer=new MutationObserver(this.check);
      this.observer.observe(document.body,{childList:true,subtree:true});

      if(!target.state?.conversationOnly)await this.loadPreview(state);
    }
    async loadPreview(state){
      if(state.previewLoading)return;
      state.previewLoading=true;
      try{
        const preview=await state.target.context.stepHandler.getRevertPreviews(state.target.session,state.target.index-1);
        if(this.editing!==state)return;
        state.preview=preview||[];
        state.previewLoaded=true;
      }catch(error){
        if(this.editing!==state)return;
        state.previewError=error?.message||String(error);
      }finally{
        state.previewLoading=false;
      }
      this.renderMeta(state);
    }
    renderEditor(state,focus=false){
      const {editorBox,draftText}=state;
      editorBox.innerHTML=`
        <textarea class="agy-inline-textarea no-focus-ring" aria-label="编辑提示词" rows="1"></textarea>
        <div class="agy-inline-files" data-files></div>
        <div class="agy-inline-footer">
          <div class="agy-inline-left">
            <span data-meta style="display:inline-flex;align-items:center;gap:8px"></span>
            <span class="agy-inline-status" data-status role="status"></span>
          </div>
          <div class="agy-inline-btns">
            <button type="button" data-cancel>取消</button>
            <button type="button" data-bottom title="撤回并填回底部输入框（可增删附件或更换模型）">回底部</button>
            <button type="button" data-send>发送</button>
          </div>
        </div>
      `;
      const textarea=editorBox.querySelector('.agy-inline-textarea');
      textarea.value=draftText;
      const resize=()=>{
        if(!textarea.style)return;
        textarea.style.height='auto';
        const h=Number(textarea.scrollHeight)||24;
        textarea.style.height=Math.min(240,Math.max(24,h))+'px';
      };
      resize();
      textarea.addEventListener('input',()=>{
        state.draftText=textarea.value;
        resize();
      });
      textarea.addEventListener('keydown',e=>{
        if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){
          e.preventDefault();e.stopPropagation();
          this.applyRevert(true);
        }else if(e.key==='Escape'){
          e.preventDefault();e.stopPropagation();
          this.stopEditing(true);
        }
      });
      editorBox.querySelector('[data-cancel]').onclick=()=>this.stopEditing(true);
      editorBox.querySelector('[data-bottom]').onclick=()=>this.applyRevert(false);
      editorBox.querySelector('[data-send]').onclick=()=>this.applyRevert(true);
      this.renderMeta(state);
      if(native.hasDraft?.(state.target.context)){
        editorBox.querySelector('[data-status]').textContent='将替换底部草稿';
      }
      if(focus&&textarea.focus){
        textarea.focus({preventScroll:true});
        const len=textarea.value.length;
        textarea.setSelectionRange?.(len,len);
      }
    }
    renderMeta(state){
      const {editorBox,button}=state;
      const metaEl=editorBox.querySelector('[data-meta]');
      const filesEl=editorBox.querySelector('[data-files]');
      if(!metaEl)return;
      const current=native.resolve(button)||state.target;
      const st=current.state;
      const conversationOnly=state.conversationOnly!==undefined?state.conversationOnly:!!st.conversationOnly;
      const loading=!conversationOnly&&state.preview===null&&!state.previewError;
      const fileText=conversationOnly?'保留文件'
        :loading?'检查变更…'
        :state.previewError?'预览失败'
        :state.preview?.length?`还原 ${state.preview.length} 文件`
        :'无文件变更';
      const hasAttachmentHint=!!(state.bubble?.querySelector?.('.agy-user-bubble-header, img, [data-testid*="attachment"]'));
      metaEl.innerHTML=`
        ${st.conversationOnlyRevertEnabled?`<label class="agy-inline-switch"><span>撤回文件</span><button type="button" role="switch" aria-label="同时撤回文件更改" aria-checked="${!conversationOnly}" style="background:${conversationOnly?'var(--secondary,rgba(120,120,128,.2))':'var(--primary,var(--cta,#007acc))'}"><span style="left:${conversationOnly?2:14}px"></span></button></label>`:''}
        <span style="opacity:.75">${esc(fileText)}</span>
        ${hasAttachmentHint?'<span style="opacity:.7" title="发送时会自动保留原消息附件；如需增删附件请点「回底部」">· 保留原附件</span>':''}
      `;
      if(filesEl){
        filesEl.innerHTML=!loading&&!state.previewError&&state.preview?.length&&!conversationOnly
          ?`<details><summary>涉及 ${state.preview.length} 个文件</summary>${state.preview.map(p=>`<div>${esc(String(p.fileUri||p.uri||'文件').split('/').pop())}</div>`).join('')}</details>`:'';
      }
      metaEl.querySelector('[role=switch]')?.addEventListener('click',()=>{
        const cur=native.resolve(button)||state.target;
        const next=!(state.conversationOnly??cur.state.conversationOnly);
        state.conversationOnly=next;
        cur.state.setConversationOnly(next);
        if(!next&&!state.previewLoaded&&!state.previewError){
          state.preview=null;
          this.renderMeta(state);
          this.loadPreview(state);
          return;
        }
        this.renderMeta(state);
      });
    }
    async applyRevert(shouldSubmit){
      const state=this.editing;
      if(!state||this.busy)return;
      let current=native.resolve(state.button)||state.target;
      if(!current)return;
      this.busy=true;
      const {editorBox}=state;
      const textarea=editorBox.querySelector('.agy-inline-textarea');
      if(textarea){state.draftText=textarea.value;textarea.disabled=true;}
      for(const b of editorBox.querySelectorAll('button'))b.disabled=true;
      const statusEl=editorBox.querySelector('[data-status]');
      if(statusEl)statusEl.textContent=shouldSubmit?'发送中…':'处理中…';

      const input=native.editor(current.context);
      const composer=input?.closest?.('[data-testid="agent-input-box"]')||null;
      try{
        if(current.state?.conversationOnlyRevertEnabled&&state.conversationOnly!==undefined&&current.state.conversationOnly!==state.conversationOnly){
          current.state.setConversationOnly(state.conversationOnly);
          await new Promise(r=>setTimeout(r,30));
          current=native.resolve(state.button)||current;
        }
        await native.perform(current);
        if(!this.mounted||this.editing!==state)return;
        native.setText(current.context,state.draftText);
        this.stopEditing(false);
        if(shouldSubmit){
          await native.submit(current.context,composer);
        }else{
          const bottomInput=native.editor(current.context)||input;
          bottomInput?.focus?.({preventScroll:true});
          const targetScroll=bottomInput?.closest?.('[data-testid="agent-input-box"]')||bottomInput;
          targetScroll?.scrollIntoView?.({block:'nearest'});
        }
      }catch(error){
        if(this.editing===state){
          if(statusEl)statusEl.textContent='撤回失败：'+(error?.message||String(error));
          if(textarea)textarea.disabled=false;
          for(const b of editorBox.querySelectorAll('button'))b.disabled=false;
        }
      }finally{
        this.busy=false;
      }
    }
    check(){
      const state=this.editing;
      if(!state||this.busy)return;
      if(!state.bubble?.isConnected||!state.editorBox?.isConnected){
        this.stopEditing(false);
      }
    }
    stopEditing(focusButton=false){
      const state=this.editing;
      this.editing=null;
      this.observer?.disconnect();
      this.observer=null;
      if(!state)return;
      for(const h of state.hosts)h.classList?.remove('agy-bubble-editing-host');
      if(state.contentEl){state.contentEl.hidden=false;state.contentEl.classList?.remove('agy-inline-hidden');}
      state.editorBox?.remove();
      if(focusButton&&state.button?.isConnected)state.button.focus?.({preventScroll:true});
    }
    unmount(){
      if(!this.mounted)return;
      this.mounted=false;
      this.stopEditing(false);
      this.style?.remove();
      document.removeEventListener('click',this.onClick,true);
      document.removeEventListener('keydown',this.onKey,true);
    }
  }
  ns.__AGY_KIT_INLINE_UNDO__=InlineUndo;
})();
