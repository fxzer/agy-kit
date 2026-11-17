(function () {
  'use strict';
  const ns=window[Symbol.for('agy.kit')]||window;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
  const n=value=>Number(value||0).toLocaleString();
  const {summarize,compact,dateKey}=ns.__AGY_KIT_USAGE__||window.__AGY_KIT_USAGE__;
  // 等间距日期使用单调三次插值，拐点切线归零，避免曲线超出相邻日期的真实用量。
  function smoothTrendPath(points){
    const slopes=points.slice(1).map(([x,y],i)=>(y-points[i][1])/(x-points[i][0]));
    const tangents=points.map((_,i)=>{
      if(i===0)return slopes[0];if(i===points.length-1)return slopes.at(-1);
      const a=slopes[i-1],b=slopes[i];return a*b>0?2*a*b/(a+b):0;
    });
    return `M${points[0].join(',')}`+points.slice(1).map(([x,y],i)=>{
      const [px,py]=points[i],dx=(x-px)/3;
      return ` C${px+dx},${py+dx*tangents[i]} ${x-dx},${y-dx*tangents[i+1]} ${x},${y}`;
    }).join('');
  }
  class ReportsPanel {
    constructor(host){this.host=host;this.range=7;this.alive=true;}
    mount(){
      this.root=document.createElement('section');this.root.id='agy-kit-reports';
      this.root.innerHTML='<div data-report-body class="text-sm text-muted-foreground"></div>';
      this.host.appendChild(this.root);this.setModules((ns.__AGY_KIT_STORE__||window.__AGY_KIT_STORE__).config.modules);
    }
    get body(){return this.root.querySelector('[data-report-body]');}
    setModules(modules){
      this.modules=modules;
      if(this.active==='history'&&modules.history===false){
        this.request?.abort();this.clearCharts();this.body.textContent='此功能已关闭，可在功能设置中开启。';
      }
    }
    show(tab){
      this.suspend();this.root.hidden=tab==='modules';
      if(tab==='usage')this.loadHistory();
    }
    suspend(){this.request?.abort();this.clearCharts();}
    async loadHistory(){
      this.active='history';
      if(this.modules.history===false){this.body.textContent='使用统计已关闭，可在功能设置中开启。';return;}
      this.request=new AbortController();const signal=this.request.signal;
      if(this.data)this.renderHistory();else this.body.textContent='正在加载客户端使用统计…';
      try{const data=await (ns.__AGY_KIT_BRIDGE_CLIENT__||window.__AGY_KIT_BRIDGE_CLIENT__).call('/history',{},90000,signal);if(!this.alive||signal.aborted)return;this.data=data;this.renderHistory();}
      catch(error){if(this.alive&&!signal.aborted){this.clearCharts();this.body.textContent=error.message;}}
    }
    renderHistory(){
      this.clearCharts();
      const metrics=summarize(this.data.daily);
      const cards=[[compact(metrics.total),'累计 Token'],[compact(metrics.peak),'单日峰值'],[metrics.activeDays+' 天','活跃天数'],[metrics.current+' 天','当前连续'],[metrics.longest+' 天','最长连续']];
      this.body.innerHTML=`<div style="display:flex;flex-direction:column;gap:20px">
        <div class="rounded-2xl" style="background:color-mix(in srgb,var(--secondary) 50%,var(--background));display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:20px 8px;gap:6px">${cards.map(([value,label])=>`<div style="text-align:center"><div class="text-foreground" style="font-size:1.1875rem;font-weight:500">${esc(value)}</div><div style="font-size:0.75rem;margin-top:7px">${label}</div></div>`).join('')}</div>
        <section class="rounded-2xl" style="background:color-mix(in srgb,var(--secondary) 50%,var(--background));padding:18px 16px">
          <h3 class="text-base text-foreground m-0 font-medium">用量热力</h3>
          <div data-heatmap style="margin-top:16px"></div>
        </section>
        <section class="rounded-2xl" style="background:color-mix(in srgb,var(--secondary) 50%,var(--background));padding:18px 16px">
          <div style="display:flex;align-items:center;justify-content:space-between"><h3 class="text-base text-foreground m-0 font-medium">每日趋势</h3>
            <div role="group" aria-label="趋势时间范围" class="flex rounded-full p-1 bg-secondary">${[7,30].map(days=>`<button class="rounded-full px-2 py-1 text-xs" data-range="${days}" aria-pressed="${this.range===days}" style="background:${this.range===days?'var(--background)':'transparent'}">近 ${days} 天</button>`).join('')}</div>
          </div><div data-trend></div>
        </section>
        <section class="rounded-2xl" style="background:color-mix(in srgb,var(--secondary) 50%,var(--background));padding:18px 16px"><h3 class="text-base text-foreground m-0 font-medium">模型用量</h3>
          ${this.renderModels()}
          ${this.data.models?.some(m=>m.name==='模型未记录')?'<p class="text-xs mt-3 mb-0">部分旧记录未包含模型名称，新采集的用量会自动补充。</p>':''}
        </section>
        ${this.data.warnings.length?`<p class="text-xs text-amber-600 m-0">${this.data.warnings.map(esc).join('；')}</p>`:''}
      </div>`;
      this.drawHeatmap();this.drawTrend();
      for(const b of this.body.querySelectorAll('[data-range]'))b.onclick=()=>{this.range=Number(b.dataset.range);this.renderHistory();};
    }
    renderModels(){
      const models=(this.data.models||[]).filter(model=>model.tokens>0);
      if(!models.length)return '<p class="text-sm mt-4 mb-0">暂无模型用量</p>';
      if(models.length>8){const rest=models.splice(7);models.push({name:'其他模型',tokens:rest.reduce((sum,model)=>sum+model.tokens,0)});}
      const total=models.reduce((sum,model)=>sum+model.tokens,0),circumference=2*Math.PI*80;
      const colors=['#5B8FF9','#34D399','#A78BFA','#FB7185','#FBBF24','#22D3EE','#F472B6','#94A3B8'];
      let offset=0;
      const slices=models.map((model,i)=>{
        const share=model.tokens/total,percent=share<.001?'&lt;0.1%':Number((share*100).toFixed(1))+'%';
        const length=share*circumference,start=offset;offset+=length;
        return {...model,color:colors[i],percent,length,start};
      });
      return `<div data-model-usage style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:20px 24px;margin-top:18px">
        <svg viewBox="0 0 220 220" role="img" aria-label="模型 Token 用量占比，合计 ${n(total)} Token" style="display:block;width:100%;max-width:220px;flex:0 1 220px">
          ${slices.map(model=>`<circle data-model-slice cx="110" cy="110" r="80" fill="none" stroke="${model.color}" stroke-width="24" stroke-dasharray="${model.length} ${circumference-model.length}" stroke-dashoffset="${-model.start}" transform="rotate(-90 110 110)"><title>${esc(model.name)}：${n(model.tokens)} Token · ${model.percent}</title></circle>`).join('')}
          <text x="110" y="106" text-anchor="middle" fill="var(--foreground)" style="font-size:1rem;font-weight:500">${compact(total)}</text>
          <text x="110" y="126" text-anchor="middle" fill="var(--muted-foreground)" style="font-size:0.75rem">Token</text>
        </svg>
        <div role="list" aria-label="各模型用量" style="flex:1 1 240px;min-width:0">${slices.map((model,i)=>`<div role="listitem" title="${esc(model.name)}：${n(model.tokens)} Token" style="padding:10px 0;${i<slices.length-1?'border-bottom:1px solid color-mix(in srgb,var(--foreground) 8%,transparent);':''}">
          <div style="display:flex;align-items:baseline;gap:8px;font-size:0.75rem"><span aria-hidden="true" style="align-self:center;flex:none;width:9px;height:9px;border-radius:3px;background:${model.color}"></span><span class="text-foreground" style="min-width:0;overflow-wrap:anywhere">${esc(model.name)}</span><span style="margin-left:auto;flex:none">${model.percent}</span></div>
          <div style="font-size:0.6875rem;margin:5px 0 0 17px">${compact(model.tokens)} Token</div>
        </div>`).join('')}</div>
      </div>`;
    }
    dailyMap(){return new Map(this.data.daily.map(day=>[day.date,{...day,tokens:day.input+day.output+day.cache+day.cacheCreate,requests:day.requests}]));}
    drawHeatmap(){
      const host=this.body.querySelector('[data-heatmap]'),daily=this.dailyMap();
      const now=new Date();now.setHours(12,0,0,0);
      const start=new Date(now);start.setDate(start.getDate()-start.getDay()-51*7);
      const max=Math.max(1,...[...daily.values()].map(d=>d.tokens));
      const months=document.createElement('div');months.style.cssText='position:relative;height:20px;font-size:0.75rem;margin-bottom:8px';
      const grid=document.createElement('div');grid.setAttribute('aria-label','过去 52 周客户端 Token 热力图');grid.setAttribute('role','group');grid.style.cssText='display:grid;grid-template-columns:repeat(52,minmax(0,1fr));grid-template-rows:repeat(7,1fr);grid-auto-flow:column;gap:2px';
      const heatBase='var(--primary,var(--link,var(--cta,#5b95f5)))';
      let month=-1;
      for(let i=0;i<364;i++){
        const d=new Date(start);d.setDate(start.getDate()+i);const key=dateKey(d),value=daily.get(key)||{tokens:0,requests:0};
        if(i%7===0&&d.getMonth()!==month){month=d.getMonth();const label=document.createElement('span');label.textContent=(month+1)+'月';label.style.cssText=`position:absolute;left:${Math.floor(i/7)/52*100}%;${i/7>48?'transform:translateX(-50%)':''}`;if(i!==0||d.getDate()<=14)months.appendChild(label);}
        const cell=document.createElement(d>now?'span':'button');
        if(d>now)cell.setAttribute('aria-hidden','true');
        else{
          cell.type='button';cell.dataset.heatmapDay=key;cell.tabIndex=key===dateKey(now)?0:-1;
          cell.setAttribute('aria-label',`${key}：${n(value.tokens)} Token · ${n(value.requests)} 次请求`);
        }
        const pct=Math.round((.32+.68*Math.sqrt(value.tokens/max))*100);
        cell.style.cssText=`aspect-ratio:1 / 1;height:auto;min-height:0;width:100%;align-self:start;box-sizing:border-box;padding:0;border:0;border-radius:2px;min-width:0;cursor:${d>now?'default':'pointer'};background:${d>now?'transparent':value.tokens?`color-mix(in srgb,${heatBase} ${pct}%,transparent)`:'var(--secondary,rgba(120,120,128,.2))'}`;grid.appendChild(cell);
      }
      host.append(months,grid);
      const legend=document.createElement('div');legend.style.cssText='display:flex;justify-content:flex-end;align-items:center;gap:5px;font-size:0.75rem;margin-top:12px';legend.innerHTML='少 '+[15,35,55,78,100].map(pct=>`<span style="width:12px;height:12px;border-radius:3px;background:color-mix(in srgb,${heatBase} ${pct}%,transparent)"></span>`).join('')+' 多';host.appendChild(legend);
      this.bindHeatmap(host,grid,daily);
    }
    bindHeatmap(host,grid,daily){
      this.heatmapEvents=new AbortController();const signal=this.heatmapEvents.signal;
      const show=event=>{
        const cell=event.target.closest('[data-heatmap-day]');if(!cell||!host.contains(cell))return;
        this.showUsageTip(cell,daily.get(cell.dataset.heatmapDay)||{});
      };
      host.addEventListener('pointerover',show,{signal});host.addEventListener('focusin',show,{signal});
      host.addEventListener('pointerout',event=>{
        const cell=event.target.closest('[data-heatmap-day]');
        if(cell===this.usageAnchor&&!cell.contains(event.relatedTarget)&&document.activeElement!==cell)this.hideUsageTip();
      },{signal});
      host.addEventListener('pointerleave',()=>{if(document.activeElement!==this.usageAnchor)this.hideUsageTip();},{signal});
      host.addEventListener('focusout',()=>this.hideUsageTip(),{signal});
      // 一个 Tab 入口，方向键按日或按周移动，避免逐个 Tab 经过全年方格。
      grid.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&this.usageTip){event.preventDefault();event.stopPropagation();this.hideUsageTip();return;}
        const delta={ArrowUp:-1,ArrowDown:1,ArrowLeft:-7,ArrowRight:7}[event.key];if(delta===undefined)return;
        const cells=[...grid.querySelectorAll('[data-heatmap-day]')],index=cells.indexOf(event.target);if(index<0)return;
        const next=cells[Math.max(0,Math.min(cells.length-1,index+delta))];event.preventDefault();
        for(const cell of cells)cell.tabIndex=cell===next?0:-1;next.focus({preventScroll:true});
      },{signal});
      window.addEventListener('scroll',()=>this.hideUsageTip(),{capture:true,signal});
      window.addEventListener('resize',()=>this.hideUsageTip(),{signal});
      document.addEventListener('pointerdown',event=>{if(this.usageAnchor&&host.contains(this.usageAnchor)&&!host.contains(event.target))this.hideUsageTip();},{signal});
    }
    showUsageTip(cell,value){
      this.hideUsageTip();this.usageAnchor=cell;
      const date=new Date((cell.dataset.trendDay||cell.dataset.heatmapDay)+'T12:00:00');
      const tip=document.createElement('div');tip.id='agy-kit-usage-tooltip';tip.setAttribute('role','tooltip');
      tip.className='surface-glass border rounded-lg bg-card text-foreground shadow-md';
      tip.style.cssText='position:fixed;z-index:10020;pointer-events:none;max-width:calc(100vw - 24px);min-width:230px;padding:10px 12px;line-height:1.45';
      tip.innerHTML=`<div style="font-size:0.75rem;font-weight:400">${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日</div>
        <div style="font-size:0.8125rem;font-weight:500;margin:3px 0 8px">${compact(value.tokens||0)} Token · ${n(value.requests)} 次请求</div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 14px;border-top:1px solid var(--border);padding-top:7px;font-size:0.6875rem">
          ${[['输入',value.input],['输出',value.output],['缓存读取',value.cache],['缓存写入',value.cacheCreate]].map(([label,tokens])=>`<div><span style="color:var(--muted-foreground)">${label}</span><span style="float:right;margin-left:10px" title="${n(tokens)}">${compact(tokens||0)}</span></div>`).join('')}
        </div><div style="font-size:0.6875rem;color:var(--muted-foreground);margin-top:7px">合计 ${compact(value.tokens||0)} Token</div>`;
      document.body.appendChild(tip);this.usageTip=tip;cell.setAttribute('aria-describedby',tip.id);
      if(cell.dataset.trendDay){cell.querySelector('[data-trend-dot]').setAttribute('r','5.5');cell.querySelector('[data-trend-guide]').setAttribute('opacity','.45');}
      else{cell.style.outline='2px solid var(--primary,var(--cta,#007acc))';cell.style.outlineOffset='1px';}
      const rect=(cell.dataset.trendDay?cell.querySelector('[data-trend-dot]'):cell).getBoundingClientRect(),box=tip.getBoundingClientRect();
      tip.style.left=Math.max(12,Math.min(innerWidth-box.width-12,rect.left+rect.width/2-box.width/2))+'px';
      tip.style.top=Math.max(12,rect.top-box.height-10>=12?rect.top-box.height-10:Math.min(innerHeight-box.height-12,rect.bottom+10))+'px';
    }
    hideUsageTip(){
      this.usageTip?.remove();this.usageTip=null;
      if(this.usageAnchor){
        const cell=this.usageAnchor;cell.removeAttribute('aria-describedby');cell.style.outline='';cell.style.outlineOffset='';
        if(cell.dataset.trendDay){cell.querySelector('[data-trend-dot]').setAttribute('r','4');cell.querySelector('[data-trend-guide]').setAttribute('opacity','0');}
        this.usageAnchor=null;
      }
    }
    clearHeatmap(){this.hideUsageTip();this.heatmapEvents?.abort();this.heatmapEvents=null;}
    clearCharts(){this.clearHeatmap();this.trendEvents?.abort();this.trendEvents=null;}
    drawTrend(){
      this.hideUsageTip();this.trendEvents?.abort();
      const host=this.body.querySelector('[data-trend]'),daily=this.dailyMap();const points=[];const now=new Date();now.setHours(12,0,0,0);
      for(let i=this.range-1;i>=0;i--){const d=new Date(now);d.setDate(d.getDate()-i);const key=dateKey(d);points.push({date:key,...(daily.get(key)||{tokens:0,requests:0})});}
      const peak=Math.max(0,...points.map(p=>p.tokens)),max=Math.max(1,peak),width=620,height=160;
      const xy=points.map((p,i)=>[12+i/(points.length-1)*(width-24),height-16-p.tokens/max*(height-32)]);
      host.innerHTML=`<svg viewBox="0 0 ${width} ${height}" style="width:100%;display:block;margin-top:12px;outline:none" role="group" aria-label="近 ${this.range} 天每日 Token 趋势">
        <style>
          [data-trend-day],[data-trend-day]:focus,[data-trend-day]:focus-visible,[data-trend-day]:active{outline:none!important;outline-style:none!important;box-shadow:none!important;-webkit-tap-highlight-color:transparent!important;}
        </style>
        ${[0,1,2,3].map(i=>`<line x1="12" x2="608" y1="${16+i*42}" y2="${16+i*42}" stroke="currentColor" opacity=".12" stroke-dasharray="3 4"/>`).join('')}
        <path fill="none" stroke="var(--primary,var(--link,var(--cta,#5b95f5)))" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="${smoothTrendPath(xy)}"/>
        ${xy.map(([x,y],i)=>`<g data-trend-day="${points[i].date}" role="button" tabindex="${i===xy.length-1?0:-1}" aria-label="${points[i].date}：${n(points[i].tokens)} Token · ${n(points[i].requests)} 次请求" style="cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent">
          <line data-trend-guide x1="${x}" x2="${x}" y1="12" y2="148" stroke="var(--primary,var(--link,var(--cta,#5b95f5)))" stroke-dasharray="3 4" opacity="0" pointer-events="none"/>
          <circle data-trend-dot cx="${x}" cy="${y}" r="4" fill="var(--primary,var(--link,var(--cta,#5b95f5)))"/>
          <circle cx="${x}" cy="${y}" r="12" fill="transparent"/>
        </g>`).join('')}
      </svg><div style="display:flex;justify-content:space-between;font-size:0.6875rem"><span>${points[0].date.slice(5)}</span><span>峰值 ${compact(peak)} Token</span><span>${points.at(-1).date.slice(5)}</span></div>`;
      this.bindTrend(host,new Map(points.map(p=>[p.date,p])));
    }
    bindTrend(host,daily){
      this.trendEvents=new AbortController();const signal=this.trendEvents.signal;
      const show=event=>{
        const point=event.target.closest('[data-trend-day]');if(!point||!host.contains(point))return;
        if(point!==this.usageAnchor)this.showUsageTip(point,daily.get(point.dataset.trendDay));
      };
      host.addEventListener('pointerover',show,{signal});host.addEventListener('focusin',show,{signal});
      host.addEventListener('pointerdown',event=>{
        const point=event.target.closest('[data-trend-day]');
        if(point&&host.contains(point)){event.preventDefault();show(event);}
      },{signal});
      host.addEventListener('pointerout',event=>{
        const point=event.target.closest('[data-trend-day]');
        if(point===this.usageAnchor&&!point.contains(event.relatedTarget)&&document.activeElement!==point)this.hideUsageTip();
      },{signal});
      host.addEventListener('pointerleave',()=>{if(document.activeElement!==this.usageAnchor)this.hideUsageTip();},{signal});
      host.addEventListener('focusout',()=>this.hideUsageTip(),{signal});
      host.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&this.usageTip){event.preventDefault();event.stopPropagation();this.hideUsageTip();return;}
        const delta={ArrowLeft:-1,ArrowRight:1,Home:-Infinity,End:Infinity}[event.key];if(delta===undefined)return;
        const points=[...host.querySelectorAll('[data-trend-day]')],index=points.indexOf(event.target);if(index<0)return;
        const next=points[Math.max(0,Math.min(points.length-1,index+delta))];event.preventDefault();
        for(const point of points)point.tabIndex=point===next?0:-1;next.focus({preventScroll:true});
      },{signal});
      window.addEventListener('scroll',()=>this.hideUsageTip(),{capture:true,signal});
      window.addEventListener('resize',()=>this.hideUsageTip(),{signal});
      document.addEventListener('pointerdown',event=>{if(this.usageAnchor&&host.contains(this.usageAnchor)&&!host.contains(event.target))this.hideUsageTip();},{signal});
    }
    destroy(){this.clearCharts();this.request?.abort();this.alive=false;this.root?.remove();}
  }
  ns.__AGY_KIT_REPORTS_PANEL__=ReportsPanel;
})();
