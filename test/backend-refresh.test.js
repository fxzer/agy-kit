const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function backend(healthBuild, daemon = true) {
  const calls = [];
  const previous = { url: 'http://127.0.0.1:1', token: 'a'.repeat(64), pid: 1, daemon };
  let spawned = false;
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(require.resolve('../src/backend-service')),
    __filename: require.resolve('../src/backend-service'), Buffer, process,
    setTimeout: callback => { callback(); }, AbortSignal,
    fetch: async url => { calls.push(url.endsWith('/health') ? 'health' : 'shutdown'); return { ok: true, json: async () => ({ build: healthBuild }) }; },
    require(name) {
      if (name === 'crypto') return { createHash: () => ({ update() { return this; }, digest: () => 'current-build' }) };
      if (name === 'fs') return { readFileSync: file => file.endsWith('backend-info.json') ? JSON.stringify({ ...previous, pid: spawned ? 2 : 1 }) : Buffer.from('source') };
      if (name === 'child_process') return { spawn() { calls.push('spawn'); spawned = true; return { pid: 2, unref() {} }; } };
      if (name === './history-store') return { HistoryStore: class {} };
      if (name === './settings-store') return {};
      return require(name);
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/backend-service'), 'utf8'), context);
  return { api: context.module.exports, calls };
}
test('热加载复用相同源码后端；旧守护进程先退出再启动新版', async () => {
  const same = backend('current-build');
  assert.equal((await same.api.ensureDaemon()).pid, 1);
  assert.deepEqual(same.calls, ['health']);
  const stale = backend('old-build');
  assert.equal((await stale.api.ensureDaemon()).pid, 2);
  assert.deepEqual(stale.calls, ['health', 'shutdown', 'spawn']);
});
test('旧宿主内后端没有版本指纹时另起新版服务，不关闭宿主', async () => {
  const oldHost = backend(undefined, false);
  assert.equal((await oldHost.api.ensureDaemon()).pid, 2);
  assert.deepEqual(oldHost.calls, ['health', 'spawn']);
});
