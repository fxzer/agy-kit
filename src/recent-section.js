/* 侧边栏顶部「最近」会话区块：活跃优先 + 最近时间，纯本地读内存状态。 */
(function (root) {
  'use strict';
  const ns = root[Symbol.for('agy.kit')] || root;
  const shared = typeof module === 'object' && module.exports
    ? require('./folder-status')
    : (ns.__AGY_KIT_SIDEBAR_API__ || {});
  const { classifyConversation, renderBadgeIcon, secondsOf, findSidebarBindings, isZhHost } = shared;
  const IGNORED_TYPES = new Set([21, 22, 23]);

  const COPY = {
    en: {
      title: 'Recent',
      aria: 'Recent conversations',
      showMore: n => `Show more (${n})`,
      showLess: 'Show less',
      justNow: 'now',
      newInProject: name => name ? `New conversation in ${name}` : 'New conversation in project'
    },
    zh: {
      title: '最近',
      aria: '最近任务',
      showMore: n => `显示更多 (${n})`,
      showLess: '收起至 5 条',
      justNow: '刚刚',
      newInProject: name => name ? `在 ${name} 中新建对话` : '在此项目中新建对话'
    }
  };

  const CHEVRON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -960 960 960" fill="currentColor" class="agy-recent-chevron shrink-0"><path d="M517.85-480l-184-184L376-706.15L602.15-480L376-253.85L333.85-296l184-184Z"></path></svg>';
  const FOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -960 960 960" fill="currentColor" class="shrink-0" data-project-glyph="folder"><path d="M172.31-180Q142-180 121-201t-21-51.31V-707.69Q100-738 121-759t51.31-21H391.92l80,80H787.69Q818-700 839-679t21,51.31v375.38Q860-222 839-201t-51.31,21H172.31Zm0-60H787.69q5.39,0 8.85-3.46t3.46-8.85V-627.69q0-5.39-3.46-8.85T787.69-640H447.38l-80-80H172.31q-5.39,0-8.85,3.46T160-707.69v455.38q0,5.39 3.46,8.85t8.85,3.46ZM160-240q0,0 0-3.46t0-8.85V-707.69q0-5.39 0-8.85t0-3.46v80q0,0 0,3.46t0,8.85v375.38q0,5.39 0,8.85t0,3.46Z"></path></svg>';
  const ADD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1.05em" height="1.05em" viewBox="0 -960 960 960" fill="currentColor" class="shrink-0" data-project-action-glyph="add"><path d="M450-450H250q-12.75,0-21.37-8.63T220-480.01t8.62-21.37T250-510H450V-710q0-12.75 8.63-21.37T480.01-740t21.37,8.62T510-710v200H710q12.75,0 21.37,8.63T740-479.99t-8.62,21.37T710-450H510v200q0,12.75-8.63,21.37T479.99-220t-21.37-8.62T450-250V-450Z"></path></svg>';

  const CSS = `
    #agy-kit-recent-section + .h-full {
      height: auto !important;
      flex: 1 1 0% !important;
      min-height: 0 !important;
    }
    #agy-kit-recent-section {
      padding: 0 8px 7px;
      margin-bottom: -8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .agy-recent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px 4px 8px;
    }
    .agy-recent-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      border: 0;
      background: transparent;
      color: inherit;
      padding: 0;
      cursor: pointer;
    }
    .agy-recent-chevron {
      transition: opacity 0.15s ease, transform 0.15s ease;
      transform: rotate(90deg);
      opacity: 0;
    }
    .agy-recent-header:hover .agy-recent-chevron,
    .agy-recent-header:focus-within .agy-recent-chevron {
      opacity: 0.85;
    }
    .agy-recent-toggle[aria-expanded="false"] .agy-recent-chevron {
      transform: rotate(0deg);
      opacity: 0.85;
    }
    .agy-recent-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      max-height: 42vh;
      overflow-y: auto;
    }
    .agy-recent-row {
      border: 0;
      text-align: left;
      font: inherit;
    }
    .agy-recent-project-add {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.35em;
      height: 1.35em;
      margin: -0.175em -2px -0.175em 4px;
      border-radius: 4px;
      color: var(--muted-foreground);
      background: transparent;
      opacity: 0;
      pointer-events: none;
      flex-shrink: 0;
      cursor: pointer;
      transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
    }
    .agy-recent-row:hover .agy-recent-project-add,
    .agy-recent-row:focus-within .agy-recent-project-add {
      opacity: 1;
      pointer-events: auto;
    }
    .agy-recent-project-add:hover,
    .agy-recent-project-add:focus-visible {
      color: var(--foreground);
      background-color: var(--sidebar-secondary, rgba(120, 120, 128, 0.18));
      outline: none;
    }
    .agy-recent-more {
      width: 100%;
      margin-top: 2px;
      padding: 5px 8px;
      border: 0;
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      transition: background-color 0.12s ease, color 0.12s ease;
    }
    @keyframes agyKitDotPulse {
      0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }
  `;

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  }

  function formatAge(seconds, nowSec = Math.floor(Date.now() / 1000), zh = false) {
    if (!seconds) return '';
    const diff = Math.max(0, nowSec - seconds);
    if (diff < 60) return zh ? COPY.zh.justNow : COPY.en.justNow;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  function resolveProjectLabel(summary, projectLabels) {
    const pid = summary?.trajectoryMetadata?.projectId;
    if (pid === 'outside-of-project') return '';
    if (pid && projectLabels?.has(pid)) return projectLabels.get(pid);
    const uri = summary?.trajectoryMetadata?.workspaceUris?.[0] || '';
    const name = decodeURIComponent(String(uri).split('/').filter(Boolean).pop() || '');
    return name || '';
  }

  function resolveProjectId(summary, projectLabels, projectLabel) {
    const pid = summary?.trajectoryMetadata?.projectId;
    if (pid && pid !== 'outside-of-project') return pid;
    const label = projectLabel ?? resolveProjectLabel(summary, projectLabels);
    if (label && projectLabels && typeof projectLabels.entries === 'function') {
      for (const [id, name] of projectLabels.entries()) {
        if (name === label && id && id !== 'outside-of-project') return id;
      }
    }
    return summary?.trajectoryMetadata?.workspaceUris?.[0] || '';
  }

  function selectRecentConversations(state, projectLabels, activeCascadeId, hasFocus = true, limit = 5, zh = isZhHost?.() ?? false) {
    const summaries = state?.trajectorySummaries?.summaries || {};
    const list = [];
    for (const [id, summary] of Object.entries(summaries)) {
      if (!summary || summary.annotations?.archived) continue;
      if (summary.trajectoryMetadata?.parentConversationId) continue;
      if (summary.trajectoryMetadata?.isBattleModeFork) continue;
      if (IGNORED_TYPES.has(summary.trajectoryType)) continue;
      const title = summary.annotations?.title || summary.summary;
      if (!title) continue;
      const updatedAt = Math.max(secondsOf(summary.lastModifiedTime), secondsOf(summary.createdTime));
      const status = classifyConversation(id, summary, state, activeCascadeId, hasFocus);
      const priority = status?.kind === 'pending' ? 3 : status?.kind === 'running' ? 2 : 1;
      const project = resolveProjectLabel(summary, projectLabels);
      const projectId = project ? resolveProjectId(summary, projectLabels, project) : '';
      list.push({
        id,
        title,
        project,
        projectId,
        updatedAt,
        status,
        priority
      });
    }
    list.sort((a, b) => (b.priority - a.priority) || (b.updatedAt - a.updatedAt));
    return { items: list.slice(0, limit), total: list.length };
  }

  function navigateToConversation(id, router) {
    if (!id) return;
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({ to: '/c/$cascadeId', params: { cascadeId: id } });
        return;
      } catch {}
    }
    const existing = typeof document === 'object' ? document.querySelector(`a[href*="/c/${id}"]`) : null;
    if (existing && typeof existing.click === 'function') {
      existing.click();
      return;
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', `/c/${id}`);
      if (typeof window === 'object' && typeof PopStateEvent === 'function') {
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    }
  }

  function startNewProjectConversation(projectId, bindings) {
    if (!projectId) return;
    const startFn = typeof bindings?.startProjectConversation === 'function' ? bindings.startProjectConversation : null;
    if (startFn) {
      try {
        startFn(projectId);
        return;
      } catch {}
    }
    const store = bindings?.store;
    if (store && typeof store.dispatch === 'function') {
      try {
        store.dispatch({ type: 'newConvoResourceSelector/setPseudoProjectSelected', payload: false });
        store.dispatch({ type: 'newConvoResourceSelector/setLastSelectedProject', payload: projectId });
      } catch {}
    }
    const router = bindings?.router || (typeof bindings?.navigate === 'function' ? bindings : null);
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({ to: '/', search: { project: projectId } });
        return;
      } catch {}
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', `/?project=${encodeURIComponent(projectId)}`);
      if (typeof window === 'object' && typeof PopStateEvent === 'function') {
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    }
  }

  class RecentSectionModule {
    constructor() {
      this.mounted = false;
      this.limit = 5;
      this.collapsed = false;
      try { this.collapsed = localStorage.getItem('agy_kit_recent_collapsed') === '1'; } catch {}
      this.section = null;
      this.style = null;
      this.storeRef = null;
      this.routerRef = null;
      this.bindingsRef = null;
      this.unsubscribe = null;
      this.timer = null;
      this.onFocus = () => this.scheduleSync();
    }

    mount() {
      if (this.mounted) return;
      this.mounted = true;
      this.style = document.createElement('style');
      this.style.id = 'agy-kit-recent-styles';
      this.style.textContent = CSS;
      document.head.appendChild(this.style);
      window.addEventListener('focus', this.onFocus);
      window.addEventListener('blur', this.onFocus);
      this.sync();
    }

    scheduleSync() {
      if (!this.mounted || this.timer) return;
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

    ensureSection(grand, parent) {
      if (this.section && this.section.parentElement === grand) return this.section;
      this.section?.remove();
      const el = document.createElement('section');
      el.id = 'agy-kit-recent-section';
      el.setAttribute('aria-label', '最近任务');
      el.addEventListener('click', e => {
        const toggle = e.target.closest?.('[data-recent-toggle]');
        if (toggle) {
          this.collapsed = !this.collapsed;
          try { localStorage.setItem('agy_kit_recent_collapsed', this.collapsed ? '1' : '0'); } catch {}
          this.sync();
          return;
        }
        const more = e.target.closest?.('[data-recent-more]');
        if (more) {
          this.limit = this.limit === 5 ? 10 : 5;
          this.sync();
          return;
        }
        const addProject = e.target.closest?.('[data-recent-project-add]');
        if (addProject) {
          e.stopPropagation?.();
          startNewProjectConversation(addProject.dataset.recentProjectAdd, this.bindingsRef || { router: this.routerRef, store: this.storeRef });
          this.scheduleSync();
          return;
        }
        const row = e.target.closest?.('[data-recent-id]');
        if (row) {
          navigateToConversation(row.dataset.recentId, this.routerRef);
          this.scheduleSync();
        }
      });
      grand.insertBefore(el, parent);
      this.section = el;
      return el;
    }

    sync() {
      if (!this.mounted) return;
      const bindings = findSidebarBindings?.();
      if (!bindings?.sidebar) {
        this.section?.remove();
        this.section = null;
        return;
      }
      const { store, router, projectLabels, sidebar } = bindings;
      this.bindingsRef = bindings;
      this.routerRef = router || this.routerRef;
      this.ensureSubscription(store);
      const parent = sidebar.parentElement;
      const grand = parent?.parentElement;
      if (!parent || !grand) return;

      const zh = isZhHost ? isZhHost() : false;
      const t = zh ? COPY.zh : COPY.en;
      const state = store.getState();
      const activeId = (typeof location === 'object' ? location.pathname.match(/\/c\/([a-f0-9-]{36})/i)?.[1] : null) || null;
      const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
      const { items, total } = selectRecentConversations(state, projectLabels, activeId, hasFocus, this.limit, zh);

      if (!total) {
        this.section?.remove();
        this.section = null;
        return;
      }

      const section = this.ensureSection(grand, parent);
      section.setAttribute('aria-label', t.aria);
      const rowsHtml = this.collapsed ? '' : `
        <div class="agy-recent-list">
          ${items.map(item => {
            const selected = item.id === activeId;
            const rowCls = [
              'agy-recent-row relative w-full select-none cursor-pointer rounded-lg flex flex-col justify-center agy-sidebar-row group px-2 py-1.5',
              selected ? 'bg-sidebar-secondary' : 'bg-transparent hover:bg-sidebar-muted'
            ].join(' ');
            const textCls = selected
              ? 'flex flex-col items-start min-w-0 transition-opacity w-full'
              : 'flex flex-col items-start min-w-0 transition-opacity w-full text-secondary-foreground group-hover:text-foreground';
            const addLabel = item.project ? t.newInProject(item.project) : '';
            const addBtnHtml = item.projectId
              ? `<span role="button" tabindex="0" class="agy-recent-project-add" data-recent-project-add="${esc(item.projectId)}" title="${esc(addLabel)}" aria-label="${esc(addLabel)}">${ADD_SVG}</span>`
              : '';
            return `
            <button type="button" class="${rowCls}" data-recent-id="${esc(item.id)}" data-selected="${selected}">
              <span class="${textCls} pointer-events-none">
                <span class="flex items-center justify-between w-full min-w-0 gap-2">
                  <span class="truncate text-left min-w-0 flex-1">${esc(item.title)}</span>
                  <span class="relative flex items-center shrink-0 gap-1.5">
                    ${item.status ? renderBadgeIcon(item.status.kind, item.status.subkind) : ''}
                    <span class="text-sm text-foreground opacity-60 min-w-4 shrink-0 text-right tabular-nums">${esc(formatAge(item.updatedAt, undefined, zh))}</span>
                  </span>
                </span>
                ${item.project ? `<span class="flex items-center justify-between gap-1 w-full min-w-0 text-sm text-left text-muted-foreground select-none"><span class="flex items-center gap-1 min-w-0 flex-1">${FOLDER_SVG}<span class="min-w-0 truncate">${esc(item.project)}</span></span>${addBtnHtml}</span>` : ''}
              </span>
            </button>
          `;
          }).join('')}
        </div>
        ${total > 5 ? `<button type="button" class="agy-recent-more text-sm bg-transparent text-muted-foreground hover:text-foreground hover:bg-sidebar-muted" data-recent-more>${this.limit === 5 ? t.showMore(Math.min(10, total)) : t.showLess}</button>` : ''}
      `;

      const html = `
        <div class="agy-recent-header">
          <h2 class="text-sm opacity-50 font-medium select-none m-0 min-w-0 flex-1 flex items-center">
            <button type="button" class="agy-recent-toggle" data-recent-toggle aria-expanded="${!this.collapsed}">
              <span class="truncate">${t.title}</span>${CHEVRON_SVG}
            </button>
          </h2>
        </div>
        ${rowsHtml}
      `;
      if (section.__agyHtml !== html) {
        section.innerHTML = html;
        section.__agyHtml = html;
      }
    }

    unmount() {
      if (!this.mounted) return;
      this.mounted = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.storeRef = null;
      this.routerRef = null;
      this.bindingsRef = null;
      window.removeEventListener('focus', this.onFocus);
      window.removeEventListener('blur', this.onFocus);
      this.section?.remove();
      this.section = null;
      this.style?.remove();
      this.style = null;
    }
  }

  const api = { RecentSectionModule, selectRecentConversations, formatAge, resolveProjectLabel, resolveProjectId, navigateToConversation, startNewProjectConversation };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ns.__AGY_KIT_RECENT_SECTION__ = RecentSectionModule;
})(typeof window === 'object' ? window : globalThis);
