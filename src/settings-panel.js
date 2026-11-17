/* 独立于胶囊生命周期的客户端 Settings 页面。 */
(function () {
  'use strict';
  const ns = window[Symbol.for('agy.kit')] || window;
  const rows = [
    ['capsule', '跑道胶囊', '在输入框底栏显示上下文用量与最近一轮速度。关闭后可随时从此页面重新开启。'],
    ['contextDetailed', '上下文明细', '在胶囊面板中显示系统、工具、用户消息与回复的分类用量。'],
    ['quotaPool', '模型配额', '显示当前模型剩余配额与恢复时间。关闭后停止请求配额接口。'],
    ['history', '使用统计', '自动记录客户端用量，显示热力图、近期趋势与连续使用天数。'],
    ['inlineUndo', '原地撤回编辑', '点击撤回后就近确认，在消息原位置编辑；保留原生附件、发送与文件回滚逻辑。'],
    ['folderStatus', '折叠项目状态提示', '项目折叠时在右侧汇总显示已完成（未读圆点）、运行中与待处理状态，不发额外网络请求。'],
    ['recentSection', '侧边栏最近任务', '在项目列表顶部同时展示最近 5 条（可展开 10 条）对话，待处理与进行中置顶。']
  ];
  class SettingsPanel {
    constructor(store) {
      this.store = store;
      this.active = false;
      this.onNativeClick = e => {
        if (!e.target.closest('#agy-kit-settings-nav') && e.target.closest('button')) this.close();
      };
    }
    mount() {
      this.observer = new MutationObserver(() => this.reconcile());
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.unsubscribe = this.store.subscribe(() => this.sync());
      this.reconcile();
    }
    reconcile() {
      if (this.nav?.isConnected) return;
      this.detach();
      if (new URL(location.href).searchParams.get('settingsOpen') !== 'true') return;
      const general = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'General' || b.textContent.trim() === '常规');
      const split = general?.closest('[data-split-root]');
      const content = split?.querySelector('.grow.w-full');
      const sidebar = general?.parentElement?.parentElement?.parentElement;
      if (!content || !sidebar) return;
      const feedback = [...sidebar.querySelectorAll('button')].find(b => /^(Give Feedback|提供反馈|发送反馈)$/.test(b.textContent.trim()));
      this.content = content;
      this.sidebar = sidebar;
      this.nav = document.createElement('div');
      this.nav.id = 'agy-kit-settings-nav';
      this.nav.className = general.parentElement.className;
      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.className = general.className.replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-secondary');
      this.button.textContent = 'AGY-KIT';
      this.button.setAttribute('aria-controls', 'agy-kit-settings-panel');
      this.button.addEventListener('click', () => this.open());
      this.nav.appendChild(this.button);
      sidebar.insertBefore(this.nav, feedback?.parentElement || null);
      sidebar.addEventListener('click', this.onNativeClick, true);
    }
    open() {
      this.active = true;
      this.content.dataset.agySettingsActive = 'true';
      this.sidebar.dataset.agyNavActive = 'true';
      this.button.setAttribute('aria-current', 'page');
      if (!this.panel) {
        this.panel = document.createElement('div');
        this.panel.id = 'agy-kit-settings-panel';
        this.panel.className = 'w-full bg-transparent h-full overflow-y-auto';
        this.panel.setAttribute('role', 'region');
        this.panel.setAttribute('aria-label', 'AGY-KIT 设置');
        this.panel.innerHTML = `
          <div class="p-6 flex flex-col gap-4 w-full max-w-2xl mx-auto">
            <div class="flex flex-col gap-2 w-full mb-2 bg-transparent">
              <h2 class="text-2xl m-0 font-medium text-foreground">AGY-KIT</h2>
              <div class="text-muted-foreground">客户端使用统计与功能设置</div>
            </div>
            <div role="tablist" aria-label="AGY-KIT 页面" class="flex gap-1 rounded-full bg-secondary p-1 self-start">
              <button role="tab" data-agy-tab="usage" class="px-3 py-1.5 rounded-full text-sm">使用统计</button>
              <button role="tab" data-agy-tab="modules" class="px-3 py-1.5 rounded-full text-sm">功能设置</button>
            </div>
            <section data-agy-modules hidden class="flex flex-col gap-3 w-full">
              <h3 class="text-base font-medium text-foreground m-0">功能模块</h3>
              <div class="agy-kit-settings-group border border-border rounded-2xl overflow-hidden">
                ${rows.map(([key, title, description]) => `
                  <div class="agy-kit-setting-row flex items-center justify-between gap-4 px-4 py-3">
                    <div class="flex flex-col gap-1 min-w-0">
                      <label id="agy-label-${key}" for="agy-switch-${key}" class="text-base text-foreground">${title}</label>
                      <p id="agy-desc-${key}" class="text-sm text-muted-foreground m-0">${description}</p>
                    </div>
                    <button id="agy-switch-${key}" data-agy-setting="${key}" type="button" role="switch"
                      aria-labelledby="agy-label-${key}" aria-describedby="agy-desc-${key}"
                      class="relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out shrink-0 h-6 w-11 cursor-pointer">
                      <span class="inline-block rounded-full transition-transform duration-200 ease-in-out shadow-sm h-4 w-4" style="background:var(--cta-foreground,#ffffff)"></span>
                    </button>
                  </div>`).join('')}
              </div>
            <p class="text-sm text-muted-foreground m-0">点击底栏胶囊查看详情；再次点击、点击外部或按 Esc 关闭。此设置入口始终保留。</p>
            </section>
          </div>`;
        for (const button of this.panel.querySelectorAll('[data-agy-setting]')) {
          button.addEventListener('click', () => {
            const key = button.dataset.agySetting;
            this.store.setModule(key, !this.store.config.modules[key]);
          });
        }
        this.content.appendChild(this.panel);
        this.reports = new (ns.__AGY_KIT_REPORTS_PANEL__ || window.__AGY_KIT_REPORTS_PANEL__)(this.panel.firstElementChild);
        this.reports.mount();
        for (const button of this.panel.querySelectorAll('[data-agy-tab]')) button.onclick=()=>this.selectTab(button.dataset.agyTab);
      }
      this.panel.hidden = false;
      this.sync();
      this.selectTab('usage');
      this.content.scrollTop = 0;
    }
    selectTab(tab) {
      for (const button of this.panel.querySelectorAll('[data-agy-tab]')) {
        const selected=button.dataset.agyTab===tab;
        button.setAttribute('aria-selected',String(selected));
        button.style.background=selected?'var(--background)':'transparent';
        button.style.boxShadow=selected?'var(--glass-shadow, 0 1px 3px rgba(0,0,0,.12))':'none';
      }
      this.panel.querySelector('[data-agy-modules]').hidden=tab!=='modules';
      this.reports.show(tab);
    }
    sync() {
      this.reports?.setModules(this.store.config.modules);
      for (const button of this.panel?.querySelectorAll('[data-agy-setting]') || []) {
        const enabled = !!this.store.config.modules[button.dataset.agySetting];
        button.setAttribute('aria-checked', String(enabled));
        button.dataset.state = enabled ? 'checked' : 'unchecked';
        button.style.background = enabled ? 'var(--cta, var(--primary, #007acc))' : 'var(--secondary)';
        button.firstElementChild.style.transform = `translateX(${enabled ? 24 : 4}px)`;
      }
    }
    close() {
      this.reports?.suspend();
      this.active = false;
      this.content?.removeAttribute('data-agy-settings-active');
      this.sidebar?.removeAttribute('data-agy-nav-active');
      this.button?.removeAttribute('aria-current');
      if (this.panel) this.panel.hidden = true;
    }
    detach() {
      this.close();
      this.sidebar?.removeEventListener('click', this.onNativeClick, true);
      this.reports?.destroy();
      this.reports = null;
      this.nav?.remove();
      this.panel?.remove();
      this.nav = this.panel = this.content = this.sidebar = this.button = null;
    }
    destroy() {
      this.observer?.disconnect();
      this.unsubscribe?.();
      this.detach();
    }
  }
  ns.__AGY_KIT_SETTINGS_PANEL__ = SettingsPanel;
})();
