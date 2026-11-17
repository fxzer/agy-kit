'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RecentSectionModule, selectRecentConversations, formatAge } = require('../src/recent-section');

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
