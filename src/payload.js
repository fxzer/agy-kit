/**
 * agy-kit: Next-Gen UI & Telemetry Suite for Google Antigravity 2.x
 * (c) 2026 fxze - MIT License
 * 
 * 100% 像素级对齐 Google Antigravity 原生设计规范：
 * - 药丸全圆角 (rounded-full, 9999px)
 * - 原生 28px (h-7) 高度与 hover:bg-secondary 交互
 * - DSH 六色堆叠上下文洞察 (对标 dsh-context)
 * - 点击展开上下文面板，和原生底栏保持一致
 * - 物理级模块独立开关，关掉即 0% 性能占用
 */
(function () {
  'use strict';

  const ns = window[Symbol.for('agy.kit')] || window;
  const store = ns.__AGY_KIT_STORE__ || window.__AGY_KIT_STORE__;
  const telemetryApi = ns.__AGY_KIT_TELEMETRY__ || window.__AGY_KIT_TELEMETRY__;
  const insightsApi = ns.__AGY_KIT_INSIGHTS__ || window.__AGY_KIT_INSIGHTS__;
  const inlineUndoCtor = ns.__AGY_KIT_INLINE_UNDO__ || window.__AGY_KIT_INLINE_UNDO__;
  const folderStatusCtor = ns.__AGY_KIT_FOLDER_STATUS__ || window.__AGY_KIT_FOLDER_STATUS__;
  const recentSectionCtor = ns.__AGY_KIT_RECENT_SECTION__ || window.__AGY_KIT_RECENT_SECTION__;
  const settingsPanelCtor = ns.__AGY_KIT_SETTINGS_PANEL__ || window.__AGY_KIT_SETTINGS_PANEL__;
  const bridgeClient = () => ns.__AGY_KIT_BRIDGE_CLIENT__ || window.__AGY_KIT_BRIDGE_CLIENT__;

  // 卸载旧版 agy-kit 实例，避免重复挂载
  const prevInstance = ns.instance || ns.__AGY_KIT_INSTANCE__ || window.__AGY_KIT_INSTANCE__;
  if (prevInstance && typeof prevInstance.destroy === 'function') {
    try { prevInstance.destroy(); } catch (e) {}
  }

  // =========================================================================
  // 3. 同源 RPC 遥测状态
  // =========================================================================
  let paneSerial = 0;

  // =========================================================================
  // 4. 模块 A：Google 原生药丸双轨跑道胶囊 (100% 原生设计语言)
  // =========================================================================
  class CapsuleModule {
    constructor(footer) {
      this.footer = footer;
      this.telemetry = telemetryApi.empty();
      this.serial = ++paneSerial;
      this.pollTimer = null;
      this.composerObserver = null;
      this.composerDebounce = null;
      this.activeUntil = 0;
      this.wasRunning = false;
      this.lastHudPollAt = 0;
      this.hudOpen = false;
      this.mounted = false;
      this.lastModel = null;
      this.onOutside = e => {
        if (!this.root?.contains(e.target) && !this.hud?.contains(e.target)) this.hideHUD();
      };
      this.onEscape = e => {
        if (e.key === 'Escape' && this.hudOpen) {
          e.stopPropagation();
          this.hideHUD();
          this.root?.focus();
        }
      };
      this.onVisibility = () => {
        if (!this.mounted) return;
        if (document.hidden) {
          this.clearPollTimer();
        } else if (this.schedulePendingRetry()) {
          return;
        } else if (this.telemetry.running || Date.now() < this.activeUntil) {
          this.schedulePoll(800 + Math.random() * 600);
        }
      };
      this.onUserSubmit = e => {
        if (!this.mounted) return;
        const box = this.footer.closest('[data-testid="agent-input-box"]') || this.footer.parentElement;
        if (!box || !box.contains(e.target)) return;
        if (e.type === 'click') {
          if (e.target.closest?.('button[aria-label="Send message"]')) this.wakeUp(12000);
        } else if (e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          this.wakeUp(12000);
        }
      };
    }

    clearPollTimer() {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
    }

    schedulePoll(delayMs) {
      this.clearPollTimer();
      if (!this.mounted || document.hidden) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.tick();
      }, delayMs);
    }

    schedulePendingRetry() {
      const retryAt = this.telemetry.retryAt || (!this.telemetry.running && store.config.modules.history !== false ? this.telemetry.archiveRetryAt : 0);
      if (!retryAt) return false;
      this.schedulePoll(Math.max(250, retryAt - Date.now()));
      return true;
    }

    wakeUp(windowMs = 12000) {
      if (!this.mounted) return;
      this.activeUntil = Math.max(this.activeUntil, Date.now() + windowMs);
      if (!this.pollTimer && !document.hidden) {
        this.schedulePoll(900 + Math.random() * 400);
      }
    }

    async tick() {
      if (!this.mounted || document.hidden) return;
      await this.pollTelemetry({ forceQuota: false, refreshQuota: false });
      if (!this.mounted) return;
      this.updateView();
      if (this.schedulePendingRetry()) return;
      if (this.telemetry.running) {
        this.wasRunning = true;
        this.schedulePoll(2000 + Math.random() * 1500);
      } else if (this.wasRunning) {
        this.wasRunning = false;
        this.activeUntil = 0;
        if (store.config.modules.quotaPool) {
          await this.pollTelemetry({ forceQuota: true, refreshQuota: true });
          if (this.mounted) this.updateView();
        }
        if (this.mounted) this.schedulePendingRetry();
      } else if (Date.now() < this.activeUntil) {
        this.schedulePoll(1800 + Math.random() * 1000);
      }
    }

    onDomSync() {
      if (!this.mounted) return;
      if (this.route !== location.pathname) {
        this.route = location.pathname;
        this.hideHUD();
        this.wasRunning = false;
        this.activeUntil = 0;
        this.clearPollTimer();
        this.pollTelemetry({ forceQuota: false, refreshQuota: false }).then(() => {
          if (!this.mounted) return;
          this.updateView();
          if (this.schedulePendingRetry()) return;
          if (this.telemetry.running) {
            this.wasRunning = true;
            this.schedulePoll(2000 + Math.random() * 1500);
          }
        });
      }
      const currentModel = insightsApi.resolveModel(this.footer);
      if (currentModel !== this.lastModel) {
        this.lastModel = currentModel;
        this.collector?.reanalyze(this.telemetry, store.config.modules, currentModel);
        this.updateView();
      }
      if ((!this.root || !this.root.isConnected) && this.footer) this.render();
    }

    pollTelemetry({ forceQuota = false, refreshQuota = true } = {}) {
      const currentModel = insightsApi.resolveModel(this.footer);
      this.lastModel = currentModel;
      return this.collector.poll(
        this.telemetry,
        store.config.modules,
        insightsApi.resolveSession(this.footer),
        currentModel,
        forceQuota,
        { refreshQuota }
      );
    }

    mount() {
      if (this.mounted) return;
      this.mounted = true;
      document.addEventListener('pointerdown', this.onOutside, true);
      document.addEventListener('keydown', this.onEscape, true);
      document.addEventListener('visibilitychange', this.onVisibility);
      document.addEventListener('click', this.onUserSubmit, true);
      document.addEventListener('keydown', this.onUserSubmit, true);
      this.collector = telemetryApi.create();
      this.route = location.pathname;
      this.render();
      this.pollTelemetry({ forceQuota: false, refreshQuota: true }).then(() => {
        if (!this.mounted) return;
        this.updateView();
        if (this.schedulePendingRetry()) return;
        if (this.telemetry.running) {
          this.wasRunning = true;
          this.schedulePoll(2000 + Math.random() * 1500);
        }
      });
      const composerScope = this.footer.closest('[data-testid="agent-input-box"]') || this.footer;
      this.composerObserver = new MutationObserver(() => {
        if (this.composerDebounce) return;
        this.composerDebounce = setTimeout(() => {
          this.composerDebounce = null;
          if (!this.mounted || this.pollTimer || this.telemetry.running) return;
          const stopBtn = composerScope.querySelector?.('button[aria-label*="Stop"], button[aria-label*="Cancel"], button[aria-label*="停止"]');
          if (stopBtn) this.wakeUp(12000);
        }, 400);
      });
      this.composerObserver.observe(composerScope, { childList: true, subtree: true });
    }

    unmount() {
      if (!this.mounted) return;
      this.mounted = false;
      document.removeEventListener('pointerdown', this.onOutside, true);
      document.removeEventListener('keydown', this.onEscape, true);
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('click', this.onUserSubmit, true);
      document.removeEventListener('keydown', this.onUserSubmit, true);
      this.collector?.stop();
      this.clearPollTimer();
      if (this.composerDebounce) clearTimeout(this.composerDebounce);
      this.composerDebounce = null;
      if (this.composerObserver) this.composerObserver.disconnect();
      this.composerObserver = null;
      const root = this.root;
      if (root) root.remove();
      this.root = null;
      this.hud?.remove();
      this.hud = null;
      this.hideHUD();
    }

    render() {
      const footer = this.footer;
      if (!footer) return;


      let root = this.root;
      if (!root || !root.isConnected) {
        root = document.createElement('button');
        root.type = 'button';
        root.setAttribute('aria-label', 'AGY-KIT 上下文与配额');
        root.setAttribute('aria-haspopup', 'dialog');
        root.setAttribute('aria-expanded', 'false');
        root.setAttribute('aria-controls', `agy-kit-hud-popover-${this.serial}`);
        root.id = this.serial === 1 ? 'agy-kit-capsule-root' : `agy-kit-capsule-root-${this.serial}`;
        this.root = root;
        root.className = 'relative flex items-center shrink-0 border-none bg-transparent p-0 rounded-full';

        // 优先挂载在模型选择器右侧，完美并列对齐原生药丸
        const modelBtn = footer.querySelector('button[data-testid="model-selector-trigger"]');
        const turboBtn = Array.from(footer.querySelectorAll('button')).find(b => 
          (b.getAttribute('aria-label') || '').includes('Turbo') || 
          (b.getAttribute('title') || '').includes('Turbo') ||
          b.innerText.includes('极速') ||
          b.innerText.includes('Turbo')
        );

        if (turboBtn && turboBtn.parentElement) {
          turboBtn.parentElement.insertBefore(root, turboBtn);
        } else if (modelBtn && modelBtn.closest('.flex')) {
          const modelContainer = modelBtn.closest('.flex');
          modelContainer.parentElement.appendChild(root);
        } else {
          footer.appendChild(root);
        }

        // 与模型、模式选择器保持一致：仅点击开关面板。
        root.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.toggleHUD(root);
        });
      }

      this.updateView();
    }

    updateView() {
      const root = this.root;
      if (!root) return;

      const hasContextData = Number.isFinite(this.telemetry.tokensUsed) && Number.isFinite(this.telemetry.tokenBudget) && this.telemetry.tokenBudget > 0;
      const percent = hasContextData ? Math.min(100, Math.max(0, Math.round((this.telemetry.tokensUsed / this.telemetry.tokenBudget) * 100))) : 0;
      const quotaPercent = this.telemetry.quotaReady ? Math.min(100, Math.max(0, this.telemetry.quota.percent)) : 0;
      const quotaColor = !this.telemetry.quotaReady ? '#0ea5e9' : (quotaPercent <= 20 ? '#e5484d' : (quotaPercent <= 50 ? '#d97706' : '#0ea5e9'));
      const qInfo = this.telemetry.quota || {};
      const quotaTitle = this.telemetry.quotaReady
        ? `${qInfo.windowLabel || '5h 限额'}: ${qInfo.percent}% 可用${qInfo.weeklyPercent !== null && qInfo.windowLabel !== '周限额' ? ` · 周限额: ${qInfo.weeklyPercent}%` : ''}`
        : '宿主未提供配额数据';
      const kVal = hasContextData ? (this.telemetry.tokensUsed / 1000).toFixed(1) : '--';
      const escAttr = v => String(v ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

      // 严格对标 Google 原生药丸按钮设计语言：
      // - 全圆角: rounded-full (9999px)
      // - 高度: h-7 (28px)
      // - 字体: text-xs, text-secondary-foreground
      // - 背景: 默认透明，hover 为原生 hover:bg-secondary
      const view = `
        <div class="agy-kit-capsule notranslate flex cursor-pointer items-center h-7 gap-1.5 rounded-full px-2.5 text-xs text-secondary-foreground select-none outline-none hover:bg-secondary transition-colors shrink-0 whitespace-nowrap">
          <!-- 实时生成速率 -->
          <span class="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <span class="text-amber-500 ${this.telemetry.speedTps > 0 ? 'agy-kit-pulse-dot' : ''}" style="font-size:0.91em">⚡</span>
            <span class="tabular-nums font-normal text-foreground/85">${this.telemetry.speedTps > 0 ? `${this.telemetry.liveEstimate ? '≈' : ''}${this.telemetry.speedTps}` : '--'}</span>
            <span class="opacity-60" style="font-size:0.85em">tok/s</span>
          </span>

          <!-- Google 原生药丸双轨跑道进度条 (显式抗对比度凹槽与平滑圆角) -->
          <div class="shrink-0" style="display:flex;flex-direction:column;gap:2px;margin:0 2px;width:44px;">
            <!-- 上轨：Context 占用跑道 -->
            <div class="rounded-full overflow-hidden relative" style="width:100%;height:3px;background:rgba(120,120,128,.2);" title="${hasContextData ? `上下文占用率: ${percent}%` : '等待宿主上下文数据'}">
              <div class="rounded-full" style="width:${percent}%;height:100%;background-color:${percent >= 85 ? '#f43f5e' : (percent >= 60 ? '#f59e0b' : '#10b981')};transition:width 300ms;"></div>
            </div>
            <!-- 下轨：配额剩余跑道 -->
            <div class="rounded-full overflow-hidden relative" style="width:100%;height:3px;background:rgba(120,120,128,.2);" title="${quotaTitle}">
              <div class="rounded-full" style="width:${quotaPercent}%;height:100%;background-color:${quotaColor};transition:width 300ms;"></div>
            </div>
          </div>

          <!-- 极简等宽 Token 数值 -->
          <span class="font-mono text-xs tabular-nums font-normal text-secondary-foreground">
            ${hasContextData ? `${kVal}k <span class="opacity-65" style="font-size:0.91em">(${percent}%)</span>${this.telemetry.error ? `<span class="text-rose-500 ml-1" title="${escAttr(this.telemetry.error)}">!</span>` : ''}` : (escAttr(this.telemetry.error) || '新对话 · 尚未生成')}
          </span>
        </div>
      `;

      if (root.__agyView !== view) {
        root.innerHTML = view;
        root.__agyView = view;
      }
      // 数据变化时更新详情；独立设置页由自己的生命周期管理。
      const hudState = JSON.stringify(this.telemetry);
      if (this.hudOpen && this.lastHudState !== hudState) {
        this.lastHudState = hudState;
        this.renderHUDContent();
      }
    }

    showHUD(anchorEl) {
      if (!anchorEl || !store.config.modules.capsule) return;
      let hud = this.hud;
      if (!hud) {
        hud = document.createElement('div');
        hud.id = `agy-kit-hud-popover-${this.serial}`;
        this.hud = hud;
        hud.className = 'agy-kit-hud-popover fixed z-[9999] w-[372px] bg-background/95 text-foreground p-4 text-xs font-sans';

        hud.setAttribute('role', 'dialog');
        hud.setAttribute('aria-label', '上下文与配额详情');

        document.body.appendChild(hud);
      }

      const rect = anchorEl.getBoundingClientRect();
      hud.style.left = `${Math.max(16, Math.min(window.innerWidth - 388, rect.left + rect.width / 2 - 186))}px`;
      hud.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      hud.style.display = 'block';
      this.hudOpen = true;
      anchorEl.setAttribute('aria-expanded', 'true');

      this.renderHUDContent();
      const now = Date.now();
      if (now - this.lastHudPollAt > 5000) {
        this.lastHudPollAt = now;
        this.pollTelemetry({ forceQuota: true, refreshQuota: true }).then(() => {
          if (this.mounted && this.hudOpen) {
            this.updateView();
            this.renderHUDContent();
          }
        });
      }
    }

    hideHUD() {
      const hud = this.hud;
      if (hud) hud.style.display = 'none';
      this.hudOpen = false;
      this.root?.setAttribute('aria-expanded', 'false');
    }

    toggleHUD(anchorEl) {
      if (this.hudOpen) this.hideHUD();
      else this.showHUD(anchorEl);
    }

    // =========================================================================
    // 5. 模块 B：DSH 六色堆叠详细上下文面板 (对标 dsh-context)
    // =========================================================================
    renderHUDContent() {
      const hud = this.hud;
      if (!hud) return;

      const c = this.telemetry.composition;
      const hasUsage = Number.isFinite(this.telemetry.tokensUsed);
      const totalUsed = hasUsage ? this.telemetry.tokensUsed : 0;
      const hasBudget = Number.isFinite(this.telemetry.tokenBudget) && this.telemetry.tokenBudget > 0;
      const budget = hasBudget ? this.telemetry.tokenBudget : 1;

      const breakdownSum = c.system + c.tools + c.user + c.response + c.toolResults;
      const percent = hasBudget ? Math.round((breakdownSum / budget) * 100) : null;
      const barBase = budget;
      const pSys = ((c.system / barBase) * 100).toFixed(1);
      const pTools = ((c.tools / barBase) * 100).toFixed(1);
      const pUser = ((c.user / barBase) * 100).toFixed(1);
      const pResp = ((c.response / barBase) * 100).toFixed(1);
      const pResults = ((c.toolResults / barBase) * 100).toFixed(1);

      const categoryColors = { system: '#a855f7', tools: '#3b82f6', user: '#10b981', response: '#f97316', results: '#f43f5e', other: 'var(--muted-foreground, #71717a)' };
      const sourceTip = '发送前本地分词估算，分类比例均以宿主上下文预算为分母；思考含在回复中';
      const sourceExpanded = hud.querySelector('details')?.open || false;
      hud.style.maxHeight = 'min(650px, 75vh)';
      hud.style.overflowY = 'auto';
      hud.innerHTML = `
        <!-- 头部 -->
        <div class="flex items-center justify-between gap-3 pb-2.5 border-b border-border/40">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="font-semibold text-sm shrink-0" style="color:var(--warning, #f59e0b)">✦</span>
            <span class="font-semibold text-foreground text-xs truncate" title="${String(this.telemetry.modelName).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}">${String(this.telemetry.modelName).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}</span>
          </div>
          <span class="text-muted-foreground/70 font-medium shrink-0 tracking-wide" style="font-size:0.625rem">AGY-KIT</span>
        </div>

        <!-- 五色堆叠上下文构成 -->
        <div data-agy-module="contextDetailed" class="py-3 border-b border-border/40 flex flex-col gap-2">
          <div class="flex justify-between items-center text-xs gap-2">
            <span class="text-muted-foreground font-medium">上下文构成 · 估算</span>
            <span class="font-mono text-foreground font-medium tabular-nums shrink-0" title="${sourceTip}">
              ${(breakdownSum / 1000).toFixed(1)}K${hasBudget ? ` / ${(budget / 1000).toFixed(0)}K <span class="text-muted-foreground font-normal">(${percent}%)</span>` : (this.telemetry.compositionReady || hasUsage ? ' · 预算未上报' : '')}
            </span>
          </div>
          ${this.telemetry.compositionReady || hasUsage ? `<div class="text-muted-foreground/70" style="font-size:0.625rem">${this.telemetry.source === '最近一轮实际用量' ? '最近一轮实际用量（含输出）' : '宿主上下文估算'}：${hasUsage ? `${(totalUsed / 1000).toFixed(1)}K` : '未上报'}</div>` : ''}

          <!-- 五色上下文堆叠条 + 右侧 15% 斜纹压缩缓冲带 -->
          <div style="position:relative;height:9px;display:${this.telemetry.compositionReady && !hasBudget ? 'none' : 'flex'};background:var(--secondary,rgba(120,120,128,.2));border-radius:5px;overflow:hidden" class="w-full overflow-hidden flex relative" title="估算分类占宿主上下文预算的比例">
            ${this.telemetry.compositionReady ? `
            <div style="width: ${pSys}%; background: ${categoryColors.system}; height: 9px; flex-shrink: 0;" class="transition-all" title="系统规则: ${c.system} (${pSys}%)"></div>
            <div style="width: ${pTools}%; background: ${categoryColors.tools}; height: 9px; flex-shrink: 0;" class="transition-all" title="工具定义: ${c.tools} (${pTools}%)"></div>
            <div style="width: ${pUser}%; background: ${categoryColors.user}; height: 9px; flex-shrink: 0;" class="transition-all" title="用户消息: ${c.user} (${pUser}%)"></div>
            <div style="width: ${pResp}%; background: ${categoryColors.response}; height: 9px; flex-shrink: 0;" class="transition-all" title="思考+回复: ${c.response} (${pResp}%)"></div>
            <div style="width: ${pResults}%; background: ${categoryColors.results}; height: 9px; flex-shrink: 0;" class="transition-all" title="工具结果: ${c.toolResults} (${pResults}%)"></div>` : ''}
            <!-- 85% 到 100% 斜纹参考缓冲带 -->
            <div style="position:absolute;top:0;bottom:0;left:85%;right:0;background:repeating-linear-gradient(45deg,rgba(245,158,11,.22) 0 4px,transparent 4px 8px);border-left:1.5px solid rgba(245,158,11,.75);z-index:10;pointer-events:auto" title="85% 上下文参考缓冲带，不代表宿主强制压缩阈值"></div>
          </div>

          ${this.telemetry.compositionReady ? `
          <!-- 五色细项清单 + 缓存命中率（3×2 网格对齐） -->
          <div class="grid grid-cols-3 gap-y-1.5 gap-x-2 pt-1 text-muted-foreground font-mono" style="font-size:0.625rem">
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-[2px] shrink-0" style="background:${categoryColors.system}"></span>系统: ${(c.system / 1000).toFixed(1)}k</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-[2px] shrink-0" style="background:${categoryColors.tools}"></span>工具: ${(c.tools / 1000).toFixed(1)}k</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-[2px] shrink-0" style="background:${categoryColors.user}"></span>用户: ${(c.user / 1000).toFixed(1)}k</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-[2px] shrink-0" style="background:${categoryColors.response}"></span>思考+回复: ${(c.response / 1000).toFixed(1)}k</span>
            <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-[2px] shrink-0" style="background:${categoryColors.results}"></span>结果: ${(c.toolResults / 1000).toFixed(1)}k</span>
            <span class="flex items-center gap-1.5 font-medium whitespace-nowrap" style="color:var(--success, #10b981)" title="Prompt 缓存命中率"><span class="w-2 h-2 rounded-full shrink-0" style="background:var(--success, #10b981)"></span>缓存命中: ${c.cacheHitRatio}</span>
          </div>` : ''}
        </div>

        <!-- 模型配额池：三栏 Bento 同心双圆环仪表卡 (60px 大圆环 + 居中标头) -->
        <div data-agy-module="quotaPool" class="pt-2.5 pb-3.5 border-b border-border/40">
          ${this.telemetry.quota.groups?.length ? (() => {
            const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
            const shortName = n => /argon/i.test(n) ? 'Argon' : /claude|gpt/i.test(n) ? 'Claude/GPT' : /gemini/i.test(n) ? 'Gemini' : n;
            const shortTime = s => String(s || '').replace(/后重置$/, '').replace('天', 'd').replace('小时', 'h').replace(/分钟|分/, 'm').trim();
            return `<div style="display:grid;grid-template-columns:repeat(${Math.min(3, this.telemetry.quota.groups.length)},minmax(0,1fr));gap:6px">
              ${this.telemetry.quota.groups.map(g => {
                const isCurrent = g.name === this.telemetry.quota.matchedGroup;
                const b5h = g.buckets.find(b => b.window === '5h');
                const bWk = g.buckets.find(b => b.window === 'weekly');
                const p5h = b5h ? Math.min(100, Math.max(0, b5h.percent)) : null;
                const pWk = bWk ? Math.min(100, Math.max(0, bWk.percent)) : null;
                const r5h = b5h ? Math.min(100, Math.max(0, b5h.percentRounded)) : null;
                const rWk = bWk ? Math.min(100, Math.max(0, bWk.percentRounded)) : null;
                // 内环 (5h): 主色调 #017ACC；外环 (1w): 同调冷青绿 #019E86（亮度权重与主色对齐）；警戒红/琥珀橙
                const colWk = pWk !== null ? (pWk <= 20 ? '#e5484d' : (pWk <= 50 ? '#d97706' : '#019E86')) : '#71717a';
                const col5h = p5h !== null ? (p5h <= 20 ? '#e5484d' : (p5h <= 50 ? '#d97706' : '#017ACC')) : '#71717a';
                // 放大至 60px：外环 r=24.5 (周长 153.94)，内环 r=17 (周长 106.81，内净径 31.2px)
                const cOut = 153.94, cIn = 106.81;
                const dashOut = rWk > 0 ? `${((rWk / 100) * cOut).toFixed(1)} ${cOut}` : '0 153.94';
                const dashIn = r5h > 0 ? `${((r5h / 100) * cIn).toFixed(1)} ${cIn}` : '0 106.81';
                const centerVal = b5h ? b5h.percentRounded : (bWk ? bWk.percentRounded : 0);
                const centerLabel = b5h ? '5h' : '1w';
                const cardStyle = isCurrent
                  ? 'border:1px solid rgba(1,122,204,.58);background:rgba(1,122,204,.09);'
                  : 'border:1px solid rgba(120,120,128,.22);background:rgba(120,120,128,.05);';
                const tooltip = [
                  g.name,
                  b5h ? `内环 (5h): ${b5h.percent}% · ${shortTime(b5h.resetCountdown)}` : '内环 (5h): 无',
                  bWk ? `外环 (1w): ${bWk.percent}% · ${shortTime(bWk.resetCountdown)}` : '外环 (1w): 无'
                ].filter(Boolean).join('\n');
                return `
                  <div class="rounded-xl px-1.5 pt-1.5 pb-2 flex flex-col items-center gap-1" style="${cardStyle}" title="${esc(tooltip)}">
                    <!-- 居中标题行 -->
                    <div class="flex items-center justify-center gap-1 w-full font-medium text-foreground/90 truncate leading-tight" style="font-size:0.625rem">
                      ${isCurrent ? '<span style="width:6px;height:6px;border-radius:9999px;background:#017ACC;flex:none"></span>' : ''}
                      <span class="truncate">${esc(shortName(g.name))}</span>
                    </div>

                    <!-- 放大版同心双圆环 (60×60px，间距缩减、内径 31.2px) -->
                    <div style="position:relative;width:60px;height:60px;margin:1px 0">
                      <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden="true">
                        <!-- 外环底轨与周额度 (1w) -->
                        <circle cx="30" cy="30" r="24.5" fill="none" stroke="${bWk ? 'rgba(120,120,128,.18)' : 'rgba(120,120,128,.08)'}" stroke-width="2.8" ${bWk ? '' : 'stroke-dasharray="2 2"'} />
                        ${rWk > 0 ? `<circle cx="30" cy="30" r="24.5" fill="none" stroke="${colWk}" stroke-width="2.8" stroke-linecap="round" stroke-dasharray="${dashOut}" transform="rotate(-90 30 30)" />` : ''}
                        <!-- 内环底轨与 5h 额度 (Argon 无 5h 则显示浅虚线) -->
                        <circle cx="30" cy="30" r="17" fill="none" stroke="${b5h ? 'rgba(120,120,128,.18)' : 'rgba(120,120,128,.08)'}" stroke-width="3" ${b5h ? '' : 'stroke-dasharray="2 2"'} />
                        ${r5h > 0 ? `<circle cx="30" cy="30" r="17" fill="none" stroke="${col5h}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dashIn}" transform="rotate(-90 30 30)" />` : ''}
                      </svg>
                      <!-- 双环圆心主读数 -->
                      <div style="position:absolute;inset:0;padding-top:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;pointer-events:none">
                        <span class="font-mono font-bold text-foreground tabular-nums" style="font-size:9.5px;line-height:1;letter-spacing:-0.3px">${centerVal}%</span>
                        <span class="text-muted-foreground/75 font-mono" style="font-size:7.5px;line-height:1;margin-top:1.5px">${centerLabel}</span>
                      </div>
                    </div>

                    <!-- 统一对齐数据行 (方案 A: 内环/外环对齐) -->
                    <div class="flex flex-col gap-0.5 w-full font-mono tabular-nums pt-0.5" style="font-size:0.5625rem">
                      ${b5h ? `
                        <div class="flex items-center justify-between gap-0.5" title="内环 (5h): ${b5h.percent}% · ${shortTime(b5h.resetCountdown)}">
                          <span class="flex items-center gap-1 min-w-0">
                            <span style="width:4.5px;height:4.5px;border-radius:9999px;background:${col5h};flex:none"></span>
                            <span class="text-muted-foreground truncate">内环(5h)</span>
                          </span>
                          <span class="font-medium text-foreground/90 shrink-0">${b5h.percentRounded}% · ${shortTime(b5h.resetCountdown)}</span>
                        </div>
                      ` : `
                        <div class="flex items-center justify-between gap-0.5 opacity-0 select-none pointer-events-none" aria-hidden="true">
                          <span class="flex items-center gap-1"><span style="width:4.5px;height:4.5px"></span><span>占位</span></span>
                          <span>--</span>
                        </div>
                      `}
                      <div class="flex items-center justify-between gap-0.5" title="${bWk ? `外环 (1w): ${bWk.percent}% · ${shortTime(bWk.resetCountdown)}` : '外环 (1w): 无'}">
                        <span class="flex items-center gap-1 min-w-0">
                          <span style="width:4.5px;height:4.5px;border-radius:9999px;background:${colWk};flex:none"></span>
                          <span class="text-muted-foreground truncate">外环(1w)</span>
                        </span>
                        <span class="font-medium text-foreground/90 shrink-0">${bWk ? `${bWk.percentRounded}% · ${shortTime(bWk.resetCountdown)}` : '--'}</span>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>`;
          })() : `
          <div class="flex items-center justify-between text-xs">
            <span class="text-muted-foreground">当前模型 · ${String(this.telemetry.quota.windowLabel || '5h 限额').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}</span>
            <span class="font-mono text-sky-500 font-medium">${this.telemetry.quotaReady ? `${this.telemetry.quota.percent}% · ${this.telemetry.quota.resetCountdown}` : '等待宿主数据'}</span>
          </div>`}
        </div>

        ${this.telemetry.error && this.telemetry.error !== '配额耗尽' ? `<p class="text-rose-500 pt-2 pb-1 text-xs font-medium">${this.telemetry.error.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}</p>` : ''}
        ${this.telemetry.archiveError ? '<p class="text-xs text-muted-foreground pt-1.5 pb-0.5">用量归档暂不可用，稍后自动重试。</p>' : ''}
        ${this.telemetry.compression ? `<p class="pt-1.5 pb-0.5">已压缩：${(this.telemetry.compression.before/1000).toFixed(1)}K → ${(this.telemetry.compression.after/1000).toFixed(1)}K，释放 ${(this.telemetry.compression.released/1000).toFixed(1)}K</p>` : ''}
        ${this.telemetry.sources?.length ? (() => {
          const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
          const items = this.telemetry.sources;
          const other = this.telemetry.sourcesOther;
          const blocks = [...items, ...(other?.tokens > 0 ? [other] : [])].filter(b => b.tokens > 0);
          const totalMap = blocks.reduce((s, x) => s + x.tokens, 0) || 1;
          const topShare = Math.min(100, (items.reduce((s, x) => s + x.tokens, 0) / totalMap) * 100).toFixed(0);
          const W = 340, H = 118;
          const laid = insightsApi?.squarify ? insightsApi.squarify(blocks, W, H) : [];
          return `
            <details class="border-b border-border/40 pb-2">
              <summary class="cursor-pointer py-2 text-xs text-muted-foreground hover:text-foreground transition-colors">上下文占用分布（Top ${items.length} 占 ${topShare}%）</summary>
              <div class="pb-2 pt-1">
                <!-- 纯净磁盘占用矩形树图 (Treemap 无下方冗余列表，悬停即看完整明细) -->
                <div style="position:relative;width:100%;height:${H}px">
                  ${laid.map(({ item, rect }) => {
                    const isOther = item.category === 'other';
                    const color = categoryColors[item.category] || 'var(--link, #5b95f5)';
                    const pct = ((item.tokens / totalMap) * 100).toFixed(1);
                    const tokLabel = item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}K` : `${item.tokens}`;
                    const bg = isOther ? 'var(--secondary, rgba(120,120,128,0.16))' : `color-mix(in srgb, ${color} 22%, transparent)`;
                    const bd = isOther ? 'var(--border, rgba(120,120,128,0.42))' : `color-mix(in srgb, ${color} 52%, transparent)`;
                    const showTitle = (rect.w >= 22 && rect.h >= 24) || (rect.w >= 60 && rect.h >= 14);
                    const showNum = rect.w >= 20 && rect.h >= 14;
                    const numText = rect.w >= 52 && rect.h >= 26 ? `${tokLabel} · ${pct}%` : `${pct}%`;
                    const pad = rect.w < 48 ? '2px 3px' : '3px 5px';
                    const gap = rect.h < 34 ? '1px' : '2px';
                    const tip = `${item.name}${!isOther && item.count > 1 ? ` ×${item.count}` : ''}：${item.tokens.toLocaleString()} tok (${pct}%)`;
                    return `<div title="${esc(tip)}" style="position:absolute;left:${(rect.x / W * 100).toFixed(2)}%;top:${(rect.y / H * 100).toFixed(2)}%;width:calc(${(rect.w / W * 100).toFixed(2)}% - 2px);height:calc(${(rect.h / H * 100).toFixed(2)}% - 2px);background:${bg};border:1px solid ${bd};border-radius:4px;padding:${pad};box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;justify-content:center;gap:${gap}">
                      ${showTitle ? `<span class="truncate font-medium ${isOther ? 'text-muted-foreground' : 'text-foreground'}" style="font-size:0.625rem;line-height:1.15;letter-spacing:-0.2px">${esc(item.name)}${!isOther && item.count > 1 && rect.w >= 44 ? ` <span class="opacity-60 font-normal">×${item.count}</span>` : ''}</span>` : ''}
                      ${showNum ? `<span class="truncate font-mono tabular-nums text-muted-foreground" style="font-size:0.5625rem;line-height:1.1;letter-spacing:-0.3px">${numText}</span>` : ''}
                    </div>`;
                  }).join('')}
                </div>
              </div>
            </details>
          `;
        })() : ''}
        <!-- 流式性能 -->
        <div class="pt-2.5 flex justify-between items-center text-xs text-muted-foreground">
          <span title="最近一轮首字延迟 (TTFT)">首字延迟: <strong class="text-foreground font-mono font-medium">${Number.isFinite(this.telemetry.timing.ttft) ? `${this.telemetry.timing.ttft}s` : '--'}</strong></span>
          <span title="${this.telemetry.liveEstimate ? '当前生成中端到端实时估算速度（含等待首字耗时）' : `端到端平均速度（总耗时 ${this.telemetry.durationSec || '--'}s，含等待与思考）${Number.isFinite(this.telemetry.streamSpeedTps) ? ` · 回复流式速率约 ${this.telemetry.streamSpeedTps} tok/s（不含思考）` : ''}`}">${this.telemetry.liveEstimate ? '估算' : '平均'}速度: <strong class="text-foreground font-mono font-medium">${this.telemetry.speedTps > 0 ? `${this.telemetry.liveEstimate ? '≈' : ''}${this.telemetry.speedTps} tok/s` : (this.telemetry.liveEstimate ? '估算中...' : '-- tok/s')}</strong></span>
        </div>
      `;

      const sourceDetails = hud.querySelector('details');
      if (sourceDetails) sourceDetails.open = sourceExpanded;
      hud.querySelectorAll('[data-agy-module]').forEach(section => {
        section.hidden = !store.config.modules[section.dataset.agyModule];
      });
      const quotaSection = hud.querySelector('[data-agy-module="quotaPool"]');
      if (quotaSection && !this.telemetry.quotaReady) {
        quotaSection.textContent = '当前模型未上报配额';
      }

    }
  }

  // =========================================================================
  // 6. 总控驱动 (Lifecycle Controller)
  // =========================================================================
  class AgKitApp {
    constructor() {
      this.panes = new Map();
      this.inlineUndo = new inlineUndoCtor();
      this.folderStatus = folderStatusCtor ? new folderStatusCtor() : null;
      this.recentSection = recentSectionCtor ? new recentSectionCtor() : null;
      this.settingsPanel = new settingsPanelCtor(store);
      this.unsubscribe = null;
      this.syncTimer = null;
    }

    start() {
      if (this.unsubscribe) return;
      this.settingsPanel.mount();
      this.paneObserver = new MutationObserver(() => {
        if (this.syncTimer) return;
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          this.syncPanes();
        }, 150);
      });
      this.paneObserver.observe(document.body, { childList: true, subtree: true });
      this.applyModules(store.config.modules);
      this.unsubscribe = store.subscribe((cfg) => {
        this.applyModules(cfg.modules);
      });
      console.log('✨ [agy-kit] 100% 原生药丸双轨套件已启动');
    }

    applyModules(modules) {
      this.syncPanes();

      if (modules.inlineUndo) this.inlineUndo.mount(); else this.inlineUndo.unmount();
      if (this.folderStatus) {
        if (modules.folderStatus !== false) this.folderStatus.mount();
        else this.folderStatus.unmount();
      }
      if (this.recentSection) {
        if (modules.recentSection !== false) this.recentSection.mount();
        else this.recentSection.unmount();
      }
    }

    syncPanes() {
      const footers = store.config.modules.capsule ? [...document.querySelectorAll('.agy-composer-footer, [class*="composer-footer"]')] : [];
      for (const [footer, pane] of this.panes) {
        if (!footers.includes(footer)) { pane.unmount(); this.panes.delete(footer); }
      }
      for (const footer of footers) {
        if (!this.panes.has(footer)) {
          const pane = new CapsuleModule(footer);
          this.panes.set(footer, pane);
          pane.mount();
        }
      }
      for (const pane of this.panes.values()) pane.onDomSync();
      if (store.config.modules.folderStatus !== false) this.folderStatus?.scheduleSync();
      if (store.config.modules.recentSection !== false) this.recentSection?.scheduleSync();
    }

    destroy() {
      if (this.unsubscribe) this.unsubscribe();
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.paneObserver?.disconnect();
      for (const pane of this.panes.values()) pane.unmount();
      this.panes.clear();
      this.folderStatus?.unmount();
      this.recentSection?.unmount();
      this.inlineUndo.unmount();
      this.settingsPanel.destroy();
      bridgeClient()?.destroy();
      const style = document.querySelector('#agy-kit-styles');
      if (style) style.remove();
    }
  }

  const instance = new AgKitApp();
  ns.__AGY_KIT_INSTANCE__ = instance;
  ns.instance = instance;
  instance.start();
})();
