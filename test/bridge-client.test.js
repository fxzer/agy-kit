const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('多个面板并发归档必须等待真实确认，前批失败后后批重试且成功记录不双写', async () => {
  let attempts = 0;
  const window = { __AGY_KIT_BRIDGE_CONFIG__: { url: 'http://local', token: 'test' } };
  const context = vm.createContext({ window, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: ++attempts > 1, json: async () => ({ error: '断网' }) }) });
  vm.runInContext(fs.readFileSync(require.resolve('../src/bridge-client'), 'utf8'), context);
  const client = window.__AGY_KIT_BRIDGE_CLIENT__;
  const rows = [{ stepIndices: [1], chatModel: { model: 'known', usage: { inputTokens: 100, outputTokens: 20 } } }];
  const steps = [{}, { metadata: { createdAt: '2026-11-17T00:00:00Z' } }];
  const results = await Promise.allSettled([client.record('s', rows, steps), client.record('s', rows, steps)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(attempts, 2);
  await client.record('s', rows, steps);
  assert.equal(attempts, 2);
  client.destroy();
  await assert.rejects(client.record('s', rows, steps), /已停止/);
});
