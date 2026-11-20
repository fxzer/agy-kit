/* 折叠项目文件夹状态汇总：纯本地读取 React/Redux 内存状态，不发任何网络请求。 */
(function (root) {
  'use strict';
  const ns = root[Symbol.for('agy.kit')] || root;
  const CASCADE_STATUS = { UNSPECIFIED: 0, IDLE: 1, RUNNING: 2, CANCELING: 3, BUSY: 4 };
  const IGNORED_TRAJECTORY_TYPES = new Set([21, 22, 23]); // KNOWLEDGE_GENERATION, SIDE_QUESTION, COMMIT_MESSAGE_GENERATION

  const CSS = `
    .agy-kit-folder-badges {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
      transition: opacity 0.15s ease;
      z-index: 2;
    }
    .group\\/header:hover .agy-kit-folder-badges,
    .group\\/header:focus-within .agy-kit-folder-badges {
      opacity: 0;
    }
    .agy-kit-folder-badge {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 0.75rem;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      color: var(--muted-foreground);
    }
    .agy-kit-folder-badge[data-kind="pending"] {
      color: var(--primary, var(--cta));
    }
    @keyframes agyKitDotPulse {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }
  `;

  function secondsOf(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.seconds !== undefined && ts.seconds !== null) return Number(ts.seconds) || 0;
    return 0;
  }

  function resolvePendingKind(waitingStep) {
    const tool = String(waitingStep?.metadata?.toolCall?.name || '').split(':').pop();
    if (tool === 'ask_permission') {
      try {
        const args = JSON.parse(waitingStep?.metadata?.toolCall?.argumentsJson || '{}');
        if (args.command || args.CommandLine) return 'terminal';
        if (args.read_file || args.write_file || args.Path || args.AbsolutePath || args.TargetFile) return 'file';
      } catch {}
      return 'lock';
    }
    if (/run_command|command/i.test(tool)) return 'terminal';
    if (/question|ask_user/i.test(tool)) return 'bell';
    return 'bell';
  }

  function classifyConversation(id, summary, state, activeCascadeId, hasFocus = true) {
    if (!id || !summary) return null;
    if (summary.annotations?.archived) return null;
    if (summary.trajectoryMetadata?.parentConversationId) return null;
    if (summary.trajectoryMetadata?.isBattleModeFork) return null;
    if (IGNORED_TRAJECTORY_TYPES.has(summary.trajectoryType)) return null;

    const summaries = state?.trajectorySummaries?.summaries || {};
    const indexes = state?.trajectorySummaries?.indexes;
    let waitingStep = summary.waitingSteps?.[0] || null;
    const rawChildren = indexes?.byParent?.[id];
    if (!waitingStep && rawChildren) {
      const childIds = typeof rawChildren[Symbol.iterator] === 'function' ? rawChildren : (typeof rawChildren === 'object' ? Object.keys(rawChildren) : []);
      for (const childId of childIds) {
        const child = summaries[childId];
        if (child?.waitingSteps?.length) {
          waitingStep = child.waitingSteps[0];
          break;
        }
      }
    }
    if (waitingStep) {
      return {
        kind: 'pending',
        subkind: resolvePendingKind(waitingStep),
        title: summary.annotations?.title || summary.summary || id
      };
    }

    const status = summary.status ?? CASCADE_STATUS.UNSPECIFIED;
    const isWorking = !summary.killed && (
      status === CASCADE_STATUS.RUNNING ||
      status === CASCADE_STATUS.BUSY ||
      status === CASCADE_STATUS.CANCELING ||
      !!summary.hasRunningSubagents
    );
    const isBackgroundWorking = !summary.killed &&
      (status === CASCADE_STATUS.IDLE || status === CASCADE_STATUS.UNSPECIFIED) &&
      !summary.hasRunningSubagents &&
      !!summary.notFullyIdle;

    if (isWorking || isBackgroundWorking) {
      return {
        kind: 'running',
        subkind: isWorking ? 'loading' : 'background',
        title: summary.annotations?.title || summary.summary || id
      };
    }

    if (!summary.notFullyIdle) {
      const marked = !!summary.annotations?.markedAsUnread;
      const isCurrentFocused = activeCascadeId === id && hasFocus;
      if (marked || !isCurrentFocused) {
        const lastMod = secondsOf(summary.lastModifiedTime);
        const remoteView = secondsOf(summary.annotations?.lastUserViewTime);
        const localView = Number(state?.conversation?.localLastViewedTimes?.[id] || 0);
        const viewedAt = Math.max(remoteView, localView);
        if (marked || (lastMod > 0 && lastMod > viewedAt)) {
          return {
            kind: 'unread',
            subkind: 'dot',
            title: summary.annotations?.title || summary.summary || id
          };
        }
      }
    }

    return null;
  }

  function isZhHost() {
    if (typeof document === 'object') {
      const title = document.querySelector?.('[data-testid="section-header"]')?.getAttribute?.('data-title') || '';
      if (title) return /[\u4e00-\u9fff]/.test(title);
      const lang = document.documentElement?.lang || '';
      if (lang) return /^zh/i.test(lang);
    }
    return false;
  }

  function aggregateProject(conversationIds, state, activeCascadeId, hasFocus = true, zh = isZhHost()) {
    const summaries = state?.trajectorySummaries?.summaries || {};
    const buckets = {
      pending: { kind: 'pending', count: 0, subkind: null, titles: [] },
      running: { kind: 'running', count: 0, subkind: null, titles: [] },
      unread: { kind: 'unread', count: 0, subkind: 'dot', titles: [] }
    };
    const seen = new Set();

    for (const id of conversationIds || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = classifyConversation(id, summaries[id], state, activeCascadeId, hasFocus);
      if (!item) continue;
      const b = buckets[item.kind];
      b.count += 1;
      if (!b.subkind || item.subkind === 'loading') b.subkind = item.subkind;
      if (b.titles.length < 3 && item.title) b.titles.push(item.title);
    }

    const active = ['pending', 'running', 'unread']
      .map(k => buckets[k])
      .filter(b => b.count > 0);

    if (!active.length) return { badges: [], summaryText: '', all: [] };

    const labels = zh
      ? { pending: '待处理', running: '运行中', unread: '已完成未读' }
      : { pending: 'action required', running: 'running', unread: 'unread' };
    const summaryText = active.map(b => zh ? `${b.count} 个${labels[b.kind]}` : `${b.count} ${labels[b.kind]}`).join(' · ');
    const detailLines = active.flatMap(b => b.titles.map(t => `${labels[b.kind]}: ${t}`)).slice(0, 4);
    const tooltipText = detailLines.length ? `${summaryText}\n${detailLines.join('\n')}` : summaryText;
    return {
      badges: active.slice(0, 2),
      all: active,
      summaryText,
      tooltipText
    };
  }

  function renderBadgeIcon(kind, subkind) {
    if (kind === 'unread') {
      return '<span aria-hidden="true" data-testid="agy-kit-folder-unread-dot" class="relative flex items-center justify-center" style="width:1em;height:1em"><span class="absolute rounded-full" style="width:0.85em;height:0.85em;background:color-mix(in srgb, var(--primary, var(--cta)) 18%, transparent)"></span><span class="rounded-full" style="width:0.42em;height:0.42em;background:var(--primary, var(--cta))"></span></span>';
    }
    if (kind === 'running') {
      if (subkind === 'background') {
        return '<svg aria-hidden="true" viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="opacity-75 shrink-0"><path d="M3.7 5.2L6.7 8L3.7 10.8"/><path d="M8.3 10.8H12.3"/></svg>';
      }
      return '<span aria-hidden="true" class="grid place-content-center shrink-0 opacity-75" style="width:1em;height:1em;grid-template-columns:repeat(2,3px);gap:2px"><span class="rounded-full bg-current" style="width:3px;height:3px;animation:agyKitDotPulse 1.4s ease-in-out 0s infinite"></span><span class="rounded-full bg-current" style="width:3px;height:3px;animation:agyKitDotPulse 1.4s ease-in-out -1.05s infinite"></span><span class="rounded-full bg-current" style="width:3px;height:3px;animation:agyKitDotPulse 1.4s ease-in-out -0.35s infinite"></span><span class="rounded-full bg-current" style="width:3px;height:3px;animation:agyKitDotPulse 1.4s ease-in-out -0.7s infinite"></span></span>';
    }
    const glyph = subkind === 'terminal'
      ? '<svg aria-hidden="true" viewBox="0 0 16 16" width="0.93em" height="0.93em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5l3 3-3 3"/><path d="M8 11h4.5"/></svg>'
      : subkind === 'lock'
        ? '<svg aria-hidden="true" viewBox="0 0 16 16" width="0.93em" height="0.93em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 16 16" width="0.93em" height="0.93em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 6.5a3.5 3.5 0 1 0-7 0c0 3.2-1.3 4.3-1.3 4.3h9.6s-1.3-1.1-1.3-4.3"/><path d="M6.8 13a1.3 1.3 0 0 0 2.4 0"/></svg>';
    return `<span aria-hidden="true" class="relative inline-flex items-center justify-center shrink-0" style="width:1em;height:1em">${glyph}<span class="absolute rounded-full" style="width:5px;height:5px;top:0;right:0;background:var(--warning, #f59e0b)"></span></span>`;
  }

  function findSidebarBindings() {
    if (typeof document !== 'object') return null;
    const sidebar = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!sidebar) return null;
    const listDiv = sidebar.firstElementChild || sidebar;
    const key = Object.keys(listDiv).find(k => k.startsWith('__reactFiber$')) || Object.keys(sidebar).find(k => k.startsWith('__reactFiber$'));
    let f = key ? (listDiv[key] || sidebar[key]) : null;
    let store = null;
    let router = null;
    let startProjectConversation = null;
    const groupsById = new Map();
    const projectLabels = new Map();
    for (let d = 0; f && d < 32; d++, f = f.return) {
      for (let s = f.memoizedState; s; s = s.next) {
        const v = s.memoizedState;
        if (!groupsById.size && Array.isArray(v) && v.length && v[0]?.conversationIds) {
          for (const g of v) {
            if (g?.id) {
              groupsById.set(g.id, g.conversationIds);
              if (typeof g.label === 'string') projectLabels.set(g.id, g.label);
            }
          }
        }
        if (!startProjectConversation && Array.isArray(v) && typeof v[0] === 'function' && String(v[0]).includes('AGENT_MANAGER_NEW_WORKSPACE_CONVERSATION')) {
          startProjectConversation = v[0];
        }
      }
      if (!store || !router) {
        for (let c = f.dependencies?.firstContext; c; c = c.next) {
          const v = c.memoizedValue;
          if (!store && v?.store && typeof v.store.getState === 'function' && typeof v.store.subscribe === 'function') {
            store = v.store;
          }
          if (!router && v && typeof v.navigate === 'function' && v.buildLocation) {
            router = v;
          }
        }
      }
      if (store && router && groupsById.size && startProjectConversation) break;
    }
    return store ? { store, router, startProjectConversation, groupsById, projectLabels, sidebar } : null;
  }

  function conversationIdsForProject(projectId, state, groupsById) {
    if (groupsById?.has(projectId)) return groupsById.get(projectId);
    const summaries = state?.trajectorySummaries?.summaries || {};
    const ids = [];
    for (const [id, summary] of Object.entries(summaries)) {
      const pid = summary?.trajectoryMetadata?.projectId || 'outside-of-project';
      if (pid === projectId) ids.push(id);
    }
    return ids;
  }

  class FolderStatusModule {
    constructor() {
      this.mounted = false;
      this.observer = null;
      this.sidebarEl = null;
      this.unsubscribe = null;
      this.storeRef = null;
      this.timer = null;
      this.style = null;
      this.onFocus = () => this.scheduleSync();
    }

    mount() {
      if (this.mounted) return;
      this.mounted = true;
      this.style = document.createElement('style');
      this.style.id = 'agy-kit-folder-status-styles';
      this.style.textContent = CSS;
      document.head.appendChild(this.style);
      window.addEventListener('focus', this.onFocus);
      window.addEventListener('blur', this.onFocus);
      this.attachObserver();
      this.sync();
    }

    attachObserver() {
      if (!this.mounted) return;
      const sidebar = document.querySelector('[data-testid="conversation-list-sidebar"]');
      if (sidebar && this.sidebarEl === sidebar) return;
      this.observer?.disconnect();
      this.sidebarEl = sidebar || null;
      this.observer = new MutationObserver(() => this.scheduleSync());
      this.observer.observe(sidebar || document.body, {
        childList: true,
        subtree: true,
        attributes: !!sidebar,
        attributeFilter: sidebar ? ['aria-expanded'] : undefined
      });
    }

    scheduleSync() {
      if (!this.mounted) return;
      this.attachObserver();
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sync();
      }, 120);
    }

    ensureSubscription(store) {
      if (this.storeRef === store) return;
      this.unsubscribe?.();
      this.storeRef = store;
      this.unsubscribe = store.subscribe(() => this.scheduleSync());
    }

    sync() {
      if (!this.mounted) return;
      this.attachObserver();
      const bindings = findSidebarBindings();
      if (!bindings) {
        this.clearBadges();
        return;
      }
      const { store, groupsById } = bindings;
      this.ensureSubscription(store);
      const state = store.getState();
      const activeId = (typeof location === 'object' ? location.pathname.match(/\/c\/([a-f0-9-]{36})/i)?.[1] : null) || null;
      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

      for (const btn of document.querySelectorAll('[data-testid="project-header"]')) {
        const container = btn.closest('[data-sidebar-section-drop-id]');
        const host = container?.querySelector('.group\\/header') || btn.parentElement;
        if (!container || !host) continue;
        const expanded = btn.getAttribute('aria-expanded') !== 'false';
        const existing = host.querySelector('.agy-kit-folder-badges');
        if (expanded) {
          existing?.remove();
          continue;
        }
        const projectId = container.getAttribute('data-sidebar-section-drop-id');
        const ids = conversationIdsForProject(projectId, state, groupsById);
        const result = aggregateProject(ids, state, activeId, hasFocus);
        if (!result.badges.length) {
          existing?.remove();
          continue;
        }
        const badgeEl = existing || document.createElement('span');
        badgeEl.className = 'agy-kit-folder-badges';
        badgeEl.setAttribute('aria-label', result.summaryText);
        badgeEl.setAttribute('title', result.tooltipText || result.summaryText);
        const html = result.badges.map(b => {
          const count = b.count > 1 ? `<span>${b.count}</span>` : '';
          return `<span class="agy-kit-folder-badge" data-kind="${b.kind}">${renderBadgeIcon(b.kind, b.subkind)}${count}</span>`;
        }).join('');
        if (badgeEl.__agyHtml !== html) {
          badgeEl.innerHTML = html;
          badgeEl.__agyHtml = html;
        }
        if (!badgeEl.isConnected) host.appendChild(badgeEl);
      }
    }

    clearBadges() {
      for (const el of document.querySelectorAll('.agy-kit-folder-badges')) el.remove();
    }

    unmount() {
      if (!this.mounted) return;
      this.mounted = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.observer?.disconnect();
      this.observer = null;
      this.sidebarEl = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.storeRef = null;
      window.removeEventListener('focus', this.onFocus);
      window.removeEventListener('blur', this.onFocus);
      this.clearBadges();
      this.style?.remove();
      this.style = null;
    }
  }

  const api = { FolderStatusModule, classifyConversation, aggregateProject, conversationIdsForProject, renderBadgeIcon, secondsOf, findSidebarBindings, isZhHost };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    ns.__AGY_KIT_FOLDER_STATUS__ = FolderStatusModule;
    ns.__AGY_KIT_SIDEBAR_API__ = api;
  }
})(typeof window === 'object' ? window : globalThis);
