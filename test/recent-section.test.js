'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RecentSectionModule, selectRecentConversations, formatAge, resolveSidebarHost } = require('../src/recent-section');

test('按待处理 > 运行中 > 其余最近时间倒序排列，并过滤归档与子智能体', () => {
  const summaries = {};
  for (let i = 1; i <= 7; i++) {
    summaries[`idle_${i}`] = {
      status: 1,
      lastModifiedTime: { seconds: 1000 + i * 10 },
      annotations: { title: `完成_${i}` },
      trajectoryMetadata: { projectId: 'p1', workspaceUris: ['file:///Users/demo/m/proj-a'] }
    };
  }
  summaries.running_old = {
    status: 2,
    notFullyIdle: true,
    lastModifiedTime: { seconds: 500 },
    annotations: { title: '运行中较早' },
    trajectoryMetadata: { workspaceUris: ['file:///Users/demo/m/demo-app'] }
  };
  summaries.pending_oldest = {
    status: 1,
    waitingSteps: [{ metadata: { toolCall: { name: 'ask_permission', argumentsJson: '{"command":"rm"}' } } }],
    lastModifiedTime: { seconds: 100 },
    annotations: { title: '等待授权最优先' },
    trajectoryMetadata: { projectId: 'p1' }
  };
  summaries.archived_item = {
    status: 1,
    lastModifiedTime: { seconds: 9999 },
    annotations: { archived: true, title: '已归档' }
  };
  summaries.side_item = {
    status: 1,
    lastModifiedTime: { seconds: 9999 },
    trajectoryType: 22,
    annotations: { title: '侧问' }
  };
  summaries.workflow_hidden = {
    status: 1,
    lastModifiedTime: { seconds: 9999 },
    summary: 'You are reviewing commit abc',
    trajectoryMetadata: { projectId: 'p1', rootConversationId: 'idle_1', sourceMetadata: { hideFromConversationList: true } }
  };
  summaries.derived_root = {
    status: 1,
    lastModifiedTime: { seconds: 9999 },
    summary: 'Derived workflow child',
    trajectoryMetadata: { projectId: 'p1', rootConversationId: 'idle_1' }
  };

  const state = { conversation: { localLastViewedTimes: {} }, trajectorySummaries: { summaries } };
  const projectLabels = new Map([['p1', 'agy-kit']]);
  const res5 = selectRecentConversations(state, projectLabels, null, true, 5);
  assert.equal(res5.total, 9);
  assert.equal(res5.items.length, 5);
  assert.deepEqual(res5.items.map(i => i.id), ['pending_oldest', 'running_old', 'idle_7', 'idle_6', 'idle_5']);
  assert.equal(res5.items[0].project, 'agy-kit');
  assert.equal(res5.items[1].project, 'demo-app');

  const res10 = selectRecentConversations(state, projectLabels, null, true, 10);
  assert.equal(res10.items.length, 9);
  assert.equal(formatAge(1000, 1030, true), '刚刚');
  assert.equal(formatAge(1000, 1030, false), 'now');
  assert.equal(formatAge(1000, 1300), '5m');
  assert.equal(formatAge(1000, 8200), '2h');
  assert.equal(formatAge(1000, 173800), '2d');
});

test('最近任务区块支持 5/10 条切换、折叠、原生路由跳转与卸载清理', () => {
  const prevDoc = global.document, prevWin = global.window;
  const listeners = new Set();
  const navigated = [];
  let styles = 0, unsubscribed = 0;

  const summaries = {};
  for (let i = 1; i <= 8; i++) {
    summaries[`c${i}`] = {
      status: 1,
      lastModifiedTime: { seconds: 1000 + i },
      annotations: { title: `会话${i}` },
      trajectoryMetadata: { projectId: 'p1' }
    };
  }
  const state = { conversation: { localLastViewedTimes: {} }, trajectorySummaries: { summaries } };
  const store = {
    getState: () => state,
    subscribe: () => () => { unsubscribed++; }
  };
  const router = {
    navigate(opts) { navigated.push(opts); },
    buildLocation() {}
  };

  const grandChildren = [];
  const grand = {
    children: grandChildren,
    insertBefore(el, ref) {
      el.parentElement = grand;
      el.isConnected = true;
      const idx = grandChildren.indexOf(ref);
      if (idx >= 0) grandChildren.splice(idx, 0, el);
      else grandChildren.push(el);
    }
  };
  const parent = { parentElement: grand };
  grandChildren.push(parent);
  const sidebar = {
    parentElement: parent,
    firstElementChild: {
      __reactFiber$1: {
        memoizedState: { memoizedState: [{ id: 'p1', label: 'agy-kit', conversationIds: Object.keys(summaries) }] },
        dependencies: { firstContext: { memoizedValue: { store, navigate: router.navigate, buildLocation: router.buildLocation } } },
        return: null
      }
    }
  };

  let createdSection = null;
  global.document = {
    documentElement: { lang: 'en' },
    head: { appendChild() { styles++; } },
    createElement: tag => {
      if (tag === 'style') {
        return { remove() { styles--; } };
      }
      const el = {
        tagName: tag.toUpperCase(),
        isConnected: false,
        parentElement: null,
        innerHTML: '',
        listeners: {},
        setAttribute() {},
        addEventListener(t, fn) { el.listeners[t] = fn; },
        remove() {
          el.isConnected = false;
          const i = grandChildren.indexOf(el);
          if (i >= 0) grandChildren.splice(i, 1);
        }
      };
      createdSection = el;
      return el;
    },
    querySelector: sel => sel === '[data-testid="conversation-list-sidebar"]' ? sidebar : null,
    hasFocus: () => true
  };
  global.window = {
    addEventListener(t) { listeners.add(t); },
    removeEventListener(t) { listeners.delete(t); }
  };

  try {
    const mod = new RecentSectionModule();
    mod.mount();
    assert.equal(styles, 1);
    assert.equal(grandChildren[0], createdSection);
    assert.equal((createdSection.innerHTML.match(/data-recent-id=/g) || []).length, 5);
    assert.match(createdSection.innerHTML, /agy-sidebar-row/);
    assert.match(createdSection.innerHTML, /hover:bg-sidebar-muted/);
    assert.match(createdSection.innerHTML, /data-project-glyph="folder"/);
    assert.match(createdSection.innerHTML, />Recent<\/span><svg[^>]*agy-recent-chevron/);
    assert.match(createdSection.innerHTML, /Show more \(8\)/);

    // 点击“Show more”切到 10 条（此例共 8 条）
    createdSection.listeners.click({
      target: { closest: sel => sel === '[data-recent-more]' ? {} : null }
    });
    assert.equal((createdSection.innerHTML.match(/data-recent-id=/g) || []).length, 8);
    assert.match(createdSection.innerHTML, /Show less/);

    // 切换中文宿主语言时同步展示中文文案
    global.document.documentElement.lang = 'zh-CN';
    mod.sync();
    assert.match(createdSection.innerHTML, />最近<\/span><svg[^>]*agy-recent-chevron/);
    assert.match(createdSection.innerHTML, /收起至 5 条/);

    // 点击其中一条触发 TanStack Router 原生跳转
    createdSection.listeners.click({
      target: { closest: sel => sel === '[data-recent-id]' ? { dataset: { recentId: 'c8' } } : null }
    });
    assert.deepEqual(navigated, [{ to: '/c/$cascadeId', params: { cascadeId: 'c8' } }]);

    // 点击标题栏右侧 "+" 按钮新建无项目对话（与 Conversations 右侧 "+" 一致）
    assert.match(createdSection.innerHTML, /data-recent-new-convo/);
    createdSection.listeners.click({
      stopPropagation() {},
      target: { closest: sel => sel === '[data-recent-new-convo]' ? {} : null }
    });
    assert.deepEqual(navigated[1], { to: '/', search: { project: 'outside-of-project' } });

    // 点击第二行项目右侧的 "+" 按钮触发该项目下新建对话，且不触发外层会话跳转
    assert.match(createdSection.innerHTML, /data-recent-project-add="p1"/);
    assert.match(createdSection.innerHTML, /data-project-action-glyph="add"/);
    createdSection.listeners.click({
      stopPropagation() {},
      target: { closest: sel => sel === '[data-recent-project-add]' ? { dataset: { recentProjectAdd: 'p1' } } : null }
    });
    assert.deepEqual(navigated[2], { to: '/', search: { project: 'p1' } });

    // 折叠与卸载清理
    createdSection.listeners.click({
      target: { closest: sel => sel === '[data-recent-toggle]' ? {} : null }
    });
    assert.equal((createdSection.innerHTML.match(/data-recent-id=/g) || []).length, 0);
    mod.unmount();
    assert.equal(grandChildren.length, 1);
    assert.equal(styles, 0);
    assert.equal(unsubscribed, 1);
    assert.equal(listeners.size, 0);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});

function makeStyleMock() {
  const map = new Map();
  return {
    marginBottom: '',
    setProperty(k, v, p) { map.set(k, p ? `${v} !${p}` : v); },
    removeProperty(k) { map.delete(k); },
    get(k) { return map.get(k); }
  };
}

test('Antigravity 2.35+ 多层 block 包装下，将区块挂载到外层纵向 Flex 容器而非破坏内层 wrapper 高度', () => {
  const prevDoc = global.document, prevWin = global.window, prevGcs = global.getComputedStyle;
  const summaries = {};
  for (let i = 1; i <= 6; i++) {
    summaries[`c${i}`] = {
      status: 1,
      lastModifiedTime: { seconds: 1000 + i },
      annotations: { title: `会话${i}` },
      trajectoryMetadata: { projectId: 'p1' }
    };
  }
  const state = { conversation: { localLastViewedTimes: {} }, trajectorySummaries: { summaries } };
  const store = { getState: () => state, subscribe: () => () => {} };
  const router = { navigate() {}, buildLocation() {} };

  const shellChildren = [];
  const scrollShell = {
    children: shellChildren,
    insertBefore(el, ref) {
      el.parentElement = scrollShell;
      el.isConnected = true;
      const idx = shellChildren.indexOf(ref);
      if (idx >= 0) shellChildren.splice(idx, 0, el);
      else shellChildren.push(el);
    }
  };
  const sidebarBounds = { parentElement: scrollShell, className: 'w-full relative flex-1 min-h-0 h-full', style: makeStyleMock() };
  shellChildren.push(sidebarBounds);
  const innerWrapper = { parentElement: sidebarBounds, className: 'relative h-full w-full', style: makeStyleMock() };
  const sidebar = {
    parentElement: innerWrapper,
    className: 'relative w-full h-full overflow-y-auto overscroll-none outline-none px-2',
    hasAttribute: attr => attr === 'data-sidebar-scroll-container',
    firstElementChild: {
      __reactFiber$1: {
        memoizedState: { memoizedState: [{ id: 'p1', label: 'agy-kit', conversationIds: Object.keys(summaries) }] },
        dependencies: { firstContext: { memoizedValue: { store, navigate: router.navigate, buildLocation: router.buildLocation } } },
        return: null
      }
    }
  };

  let createdSection = null;
  global.getComputedStyle = el => {
    if (el === scrollShell) return { display: 'flex', flexDirection: 'column', rowGap: '16px' };
    if (el === sidebar) return { display: 'block', overflowY: 'auto' };
    return { display: 'block', flexDirection: 'row', rowGap: '0px', overflowY: 'visible' };
  };
  global.document = {
    body: {},
    documentElement: { lang: 'zh-CN' },
    head: { appendChild() {} },
    createElement: tag => {
      if (tag === 'style') return { remove() {} };
      const el = {
        tagName: tag.toUpperCase(),
        isConnected: false,
        parentElement: null,
        style: makeStyleMock(),
        innerHTML: '',
        setAttribute() {},
        addEventListener() {},
        remove() {
          el.isConnected = false;
          const i = shellChildren.indexOf(el);
          if (i >= 0) shellChildren.splice(i, 1);
        }
      };
      createdSection = el;
      return el;
    },
    querySelector: sel => sel === '[data-testid="conversation-list-sidebar"]' ? sidebar : null,
    hasFocus: () => true
  };
  global.window = { addEventListener() {}, removeEventListener() {} };

  try {
    const resolved = resolveSidebarHost(sidebar);
    assert.equal(resolved.host, scrollShell);
    assert.equal(resolved.slot, sidebarBounds);
    assert.equal(resolved.isBoundedSlot, true);

    const mod = new RecentSectionModule();
    mod.mount();

    // 插入到 scrollShell 位于 sidebarBounds 之前，而非插入进 display:block 的 sidebarBounds
    assert.equal(shellChildren[0], createdSection);
    assert.equal(shellChildren[1], sidebarBounds);
    assert.equal(createdSection.style.marginBottom, '-8px');

    // 内层 wrapper 保持原生 h-full，不被错误设为 height: auto !important
    assert.equal(innerWrapper.style.get('height'), undefined);
    // 外层弹性槽位 sidebarBounds 获得受限弹性高度
    assert.equal(sidebarBounds.style.get('height'), 'auto !important');
    assert.equal(sidebarBounds.style.get('flex'), '1 1 0% !important');

    // 卸载时自动还原内联样式并移出 DOM
    mod.unmount();
    assert.equal(shellChildren.length, 1);
    assert.equal(sidebarBounds.style.get('height'), undefined);
    assert.equal(sidebarBounds.style.get('flex'), undefined);
    assert.equal(sidebarBounds.style.get('min-height'), undefined);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
    global.getComputedStyle = prevGcs;
  }
});

test('移动端首页等非独立滚动场景下不强行覆盖 slot 的弹性尺寸，且 gap 为 0 时无负外边距重叠', () => {
  const prevDoc = global.document, prevGcs = global.getComputedStyle;
  const scrollShell = { parentElement: null };
  const mobileSlot = { parentElement: scrollShell, className: 'shrink-0', style: makeStyleMock() };
  const sidebarBounds = { parentElement: mobileSlot, className: 'w-full relative' };
  const sidebar = {
    parentElement: sidebarBounds,
    className: 'relative w-full px-2',
    hasAttribute: () => false
  };
  global.document = { body: {}, documentElement: {} };
  global.getComputedStyle = el => {
    if (el === scrollShell) return { display: 'flex', flexDirection: 'column', rowGap: '0px' };
    return { display: 'block', overflowY: 'visible', rowGap: '0px' };
  };
  try {
    const resolved = resolveSidebarHost(sidebar);
    assert.equal(resolved.host, scrollShell);
    assert.equal(resolved.slot, mobileSlot);
    assert.equal(resolved.isBoundedSlot, false);
    assert.equal(resolved.rowGap, 0);
  } finally {
    global.document = prevDoc;
    global.getComputedStyle = prevGcs;
  }
});
