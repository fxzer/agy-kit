'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FolderStatusModule, classifyConversation, aggregateProject } = require('../src/folder-status');

test('准确分类等待授权、运行中、后台运行与已完成未读状态，忽略归档与子智能体', () => {
  const state = {
    conversation: { localLastViewedTimes: { c_read: 200, c_unread: 100 } },
    trajectorySummaries: {
      summaries: {
        c_perm_cmd: { status: 1, waitingSteps: [{ metadata: { toolCall: { name: 'ask_permission', argumentsJson: '{"command":"ls"}' } } }], annotations: { title: '命令授权' } },
        c_perm_lock: { status: 1, waitingSteps: [{ metadata: { toolCall: { name: 'ask_permission', argumentsJson: '{}' } } }], annotations: { title: '通用授权' } },
        c_parent: { status: 1, hasActiveChildren: true, annotations: { title: '父会话' } },
        c_child: { status: 1, waitingSteps: [{ metadata: { toolCall: { name: 'ask_question' } } }], trajectoryMetadata: { parentConversationId: 'c_parent' } },
        c_run: { status: 2, notFullyIdle: true, annotations: { title: '生成中' } },
        c_bg: { status: 1, notFullyIdle: true, annotations: { title: '后台任务' } },
        c_unread: { status: 1, notFullyIdle: false, lastModifiedTime: { seconds: 150 }, annotations: { title: '已完成任务' } },
        c_read: { status: 1, notFullyIdle: false, lastModifiedTime: { seconds: 150 }, annotations: { title: '已读任务' } },
        c_archived: { status: 1, lastModifiedTime: { seconds: 999 }, annotations: { archived: true } },
        c_side: { status: 1, lastModifiedTime: { seconds: 999 }, trajectoryType: 22 }
      },
      indexes: { byParent: { c_parent: ['c_child'] } }
    }
  };
  const sums = state.trajectorySummaries.summaries;
  assert.deepEqual(classifyConversation('c_perm_cmd', sums.c_perm_cmd, state, null), { kind: 'pending', subkind: 'terminal', title: '命令授权' });
  assert.deepEqual(classifyConversation('c_perm_lock', sums.c_perm_lock, state, null), { kind: 'pending', subkind: 'lock', title: '通用授权' });
  assert.deepEqual(classifyConversation('c_parent', sums.c_parent, state, null), { kind: 'pending', subkind: 'bell', title: '父会话' });
  assert.deepEqual(classifyConversation('c_run', sums.c_run, state, null), { kind: 'running', subkind: 'loading', title: '生成中' });
  assert.deepEqual(classifyConversation('c_bg', sums.c_bg, state, null), { kind: 'running', subkind: 'background', title: '后台任务' });
  assert.deepEqual(classifyConversation('c_unread', sums.c_unread, state, null), { kind: 'unread', subkind: 'dot', title: '已完成任务' });
  // 当前正在聚焦打开的会话不显示未读蓝点
  assert.equal(classifyConversation('c_unread', sums.c_unread, state, 'c_unread', true), null);
  assert.equal(classifyConversation('c_read', sums.c_read, state, null), null);
  assert.equal(classifyConversation('c_archived', sums.c_archived, state, null), null);
  assert.equal(classifyConversation('c_side', sums.c_side, state, null), null);
  assert.equal(classifyConversation('c_child', sums.c_child, state, null), null);
});

test('方案 A 聚合规则：最多并排展示前 2 类状态，完整明细写入 tooltipText', () => {
  const state = {
    conversation: { localLastViewedTimes: {} },
    trajectorySummaries: {
      summaries: {
        p1: { status: 1, waitingSteps: [{ metadata: { toolCall: { name: 'ask_question' } } }], annotations: { title: '等选择' } },
        r1: { status: 2, notFullyIdle: true, annotations: { title: '正在跑' } },
        u1: { status: 1, lastModifiedTime: { seconds: 100 }, annotations: { title: '已完成A' } },
        u2: { status: 1, lastModifiedTime: { seconds: 200 }, annotations: { title: '已完成B' } }
      }
    }
  };
  const single = aggregateProject(['u1'], state, null);
  assert.equal(single.badges.length, 1);
  assert.equal(single.badges[0].kind, 'unread');
  assert.equal(single.badges[0].count, 1);

  const sameKind = aggregateProject(['u1', 'u2'], state, null);
  assert.equal(sameKind.badges.length, 1);
  assert.equal(sameKind.badges[0].count, 2);

  const mixed = aggregateProject(['u1', 'p1', 'r1', 'u2'], state, null, true, true);
  assert.deepEqual(mixed.badges.map(b => [b.kind, b.count]), [['pending', 1], ['running', 1]]);
  assert.match(mixed.summaryText, /1 个待处理 · 1 个运行中 · 2 个已完成未读/);
  assert.match(mixed.tooltipText, /已完成未读: 已完成A/);
  const mixedEn = aggregateProject(['u1', 'p1', 'r1', 'u2'], state, null, true, false);
  assert.match(mixedEn.summaryText, /1 action required · 1 running · 2 unread/);
});

test('折叠项目渲染角标，展开时清除，卸载时释放全部监听与样式', () => {
  const prevDoc = global.document, prevWin = global.window, prevMut = global.MutationObserver;
  const listeners = new Set();
  let styles = 0, unsubscribed = 0, disconnected = 0;

  function makeEl(tag = 'span') {
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      isConnected: false,
      children: [],
      style: {},
      className: '',
      innerHTML: '',
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      appendChild(c) { c.isConnected = true; el.children.push(c); return c; },
      remove() { el.isConnected = false; const idx = host.children.indexOf(el); if (idx >= 0) host.children.splice(idx, 1); },
      querySelector(sel) {
        if (sel === '.agy-kit-folder-badges') return el.children.find(c => c.className === 'agy-kit-folder-badges') || null;
        if (sel === '.group\\/header') return host;
        return null;
      },
      closest(sel) { return sel === '[data-sidebar-section-drop-id]' ? section : null; }
    };
    return el;
  }

  const host = makeEl('div');
  const btn = makeEl('button');
  btn.setAttribute('data-testid', 'project-header');
  btn.setAttribute('aria-expanded', 'false');
  const section = makeEl('div');
  section.setAttribute('data-sidebar-section-drop-id', 'proj-1');
  section.querySelector = s => s === '.group\\/header' ? host : null;
  btn.closest = s => s === '[data-sidebar-section-drop-id]' ? section : null;

  let state = {
    conversation: { localLastViewedTimes: {} },
    trajectorySummaries: { summaries: { c1: { status: 1, lastModifiedTime: { seconds: 100 }, annotations: { title: '完成项' } } } }
  };
  let subFn = null;
  const store = {
    getState: () => state,
    subscribe: fn => { subFn = fn; return () => { unsubscribed++; subFn = null; }; }
  };
  const sidebar = {
    firstElementChild: {
      __reactFiber$1: {
        memoizedState: { memoizedState: [{ id: 'proj-1', conversationIds: ['c1'] }] },
        dependencies: { firstContext: { memoizedValue: { store } } },
        return: null
      }
    }
  };

  global.document = {
    body: {},
    head: { appendChild() { styles++; } },
    createElement: tag => {
      const e = makeEl(tag);
      e.remove = () => { if (tag === 'style') styles--; e.isConnected = false; const idx = host.children.indexOf(e); if (idx >= 0) host.children.splice(idx, 1); };
      return e;
    },
    querySelector: sel => sel === '[data-testid="conversation-list-sidebar"]' ? sidebar : null,
    querySelectorAll: sel => {
      if (sel === '[data-testid="project-header"]') return [btn];
      if (sel === '.agy-kit-folder-badges') return host.children.filter(c => c.className === 'agy-kit-folder-badges');
      return [];
    },
    hasFocus: () => true
  };
  global.window = {
    addEventListener(t) { listeners.add(t); },
    removeEventListener(t) { listeners.delete(t); }
  };
  global.MutationObserver = class {
    observe() {}
    disconnect() { disconnected++; }
  };

  try {
    const mod = new FolderStatusModule();
    mod.mount();
    assert.equal(styles, 1);
    assert.equal(host.children.length, 1);
    assert.match(host.children[0].innerHTML, /status-unread-dot|agy-kit-folder-unread-dot/);

    // 展开后应立即清除角标
    btn.setAttribute('aria-expanded', 'true');
    mod.sync();
    assert.equal(host.children.length, 0);

    // 再次折叠并卸载，应完整释放监听与样式
    btn.setAttribute('aria-expanded', 'false');
    mod.sync();
    assert.equal(host.children.length, 1);
    assert.equal(typeof subFn, 'function');
    mod.unmount();
    assert.equal(host.children.length, 0);
    assert.equal(styles, 0);
    assert.equal(unsubscribed, 1);
    assert.ok(disconnected >= 1);
    assert.equal(listeners.size, 0);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
    global.MutationObserver = prevMut;
  }
});
