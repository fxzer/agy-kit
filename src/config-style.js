(function () {
'use strict';
  const ns = window[Symbol.for('agy.kit')] || window;
  const DEFAULT_CONFIG = {
    modules: {
      capsule: true,          // 底栏全圆角双轨跑道胶囊
      contextDetailed: true,  // DSH 六色堆叠详细上下文面板
      quotaPool: true,        // 5 小时配额恢复监控
      history: true,
      inlineUndo: false,      // 按需开启原地撤回编辑
      folderStatus: true,     // 折叠项目文件夹状态汇总提示
      recentSection: true     // 侧边栏顶部最近任务（5/10 条）
    }
  };

  class ConfigStore {
    constructor() {
      this.config = this.load();
      this.listeners = new Set();
      this.persist();
    }

    load() {
      const sanitize = (source) => {
        const modules = Object.assign({}, DEFAULT_CONFIG.modules);
        if (source && typeof source === 'object') {
          for (const key of Object.keys(DEFAULT_CONFIG.modules)) {
            if (Object.prototype.hasOwnProperty.call(source, key)) modules[key] = source[key];
          }
        }
        return { modules };
      };
      try {
        const disk = (ns.bridgeConfig || window.__AGY_KIT_BRIDGE_CONFIG__)?.settings;
        if(disk?.modules)return sanitize(disk.modules);
        const saved = localStorage.getItem('agy_kit_config');
        if (!saved) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        const parsed = JSON.parse(saved);
        return sanitize(parsed.modules);
      } catch (e) {
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      }
    }

    save(next) {
      this.config = Object.assign({}, this.config, next);
      try {
        localStorage.setItem('agy_kit_config', JSON.stringify(this.config));
      } catch (e) {}
      this.persist();
      this.notify();
    }

    persist() {
      if(!(ns.bridgeConfig || window.__AGY_KIT_BRIDGE_CONFIG__))return;
      const client = ns.__AGY_KIT_BRIDGE_CLIENT__ || window.__AGY_KIT_BRIDGE_CLIENT__;
      if(!client)return;
      const snapshot={modules:{...this.config.modules}};
      this.persisting=(this.persisting||Promise.resolve()).catch(()=>{}).then(()=>client.call('/settings',snapshot,10000)).catch(error=>console.warn('[agy-kit] 设置未写入本地：',error.message));
    }

    setModule(key, enabled) {
      const nextModules = Object.assign({}, this.config.modules, { [key]: enabled });
      this.save({ modules: nextModules });
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    notify() {
      for (const fn of this.listeners) {
        try { fn(this.config); } catch (e) {}
      }
    }
  }

  const store = new ConfigStore();

  // =========================================================================
  // 2. 原生微动效与毛玻璃 HUD 样式
  // =========================================================================
  const STYLES = `
    [data-agy-settings-active="true"] > :not(#agy-kit-settings-panel) { display: none !important; }
    #agy-kit-settings-panel [hidden] { display: none !important; }
    #agy-kit-settings-panel[hidden] { display: none !important; }
    #agy-kit-settings-nav button[aria-current="page"] { background: var(--sidebar-secondary, rgba(120,120,128,.18)); color: var(--foreground); }
    [data-agy-nav-active="true"] button.bg-sidebar-secondary { background: transparent; }
    #agy-kit-settings-panel .agy-kit-setting-row + .agy-kit-setting-row { border-top: 1px solid var(--border, rgba(120,120,128,.15)); }
    #agy-kit-settings-panel [role="switch"] { width:44px; height:24px; padding:0; border:0; }
    #agy-kit-settings-panel [role="switch"] > span { width:16px; height:16px; }
    #agy-kit-settings-panel [role="switch"]:focus-visible,
    [id^="agy-kit-capsule-root"]:focus-visible { outline:2px solid var(--primary, var(--cta, #007acc)); outline-offset:3px; }
    [data-trend-day],[data-trend-day]:focus,[data-trend-day]:focus-visible,[data-trend-day]:active { outline:none !important; box-shadow:none !important; }

    .agy-kit-capsule {
      font-feature-settings: "tnum" 1;
      border-radius: 9999px !important;
      min-height: 1.75rem;
      background-color: transparent;
      transition: background-color 0.15s ease, opacity 0.15s ease;
    }
    .agy-kit-capsule:hover {
      background-color: var(--secondary);
    }
    .agy-kit-hud-popover {
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-radius: 16px;
      box-shadow: var(--glass-shadow, 0 16px 40px -8px rgba(0, 0, 0, 0.18)), 0 0 0 1px var(--border);
      animation: agyKitFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      transform-origin: bottom center;
    }
    @keyframes agyKitFadeIn {
      from { opacity: 0; transform: translateY(5px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .agy-kit-pulse-dot {
      animation: agyKitBreathe 1.8s infinite ease-in-out;
    }
    @keyframes agyKitBreathe {
      0%, 100% { opacity: 0.35; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.15); }
    }
  `;

  let styleTag = document.querySelector('#agy-kit-styles');
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'agy-kit-styles';
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = STYLES;

ns.__AGY_KIT_STORE__ = store;
})();
