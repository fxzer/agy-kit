const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const telemetryApi = require('../src/telemetry');

function capsule() {
  const source = fs.readFileSync(require.resolve('../src/payload'), 'utf8');
  const context = vm.createContext({ paneSerial: 0, telemetryApi, Date,
    store: { config: { modules: { history: true, contextDetailed: true, quotaPool: false } } },
    document: { hidden: false } });
  vm.runInContext(source.slice(source.indexOf('  class CapsuleModule'), source.indexOf('  class AgKitApp')) + '\nthis.CapsuleModule = CapsuleModule;', context);
  const instance = new context.CapsuleModule(null);
  instance.hud = { style: {}, querySelector: () => null, querySelectorAll: () => [] };
  return instance;
}
test('估算分类数值、预算百分比与条宽一致，实际用量单独标注', () => {
  const c = capsule();
  Object.assign(c.telemetry, { tokensUsed: 10000, tokenBudget: 100000, source: '最近一轮实际用量', compositionReady: true });
  Object.assign(c.telemetry.composition, { system: 10000, tools: 10000 });
  c.renderHUDContent();
  assert.match(c.hud.innerHTML, /上下文构成 · 估算/);
  assert.match(c.hud.innerHTML, /20\.0K \/ 100K/);
  assert.match(c.hud.innerHTML, /\(20%\)/);
  assert.match(c.hud.innerHTML, /width: 10\.0%;[^>]+title="系统规则: 10000 \(10\.0%\)"/);
  assert.match(c.hud.innerHTML, /最近一轮实际用量（含输出）：10\.0K/);
});
test('零回复速率可见，预算缺失不编造百分比', () => {
  const c = capsule();
  c.telemetry.streamSpeedTps = 0;
  c.telemetry.tokensUsed = 10000;
  c.telemetry.source = '最近一轮实际用量';
  c.renderHUDContent();
  assert.match(c.hud.innerHTML, /回复流式速率约 0 tok\/s（不含思考）/);
  assert.match(c.hud.innerHTML, /预算未上报/);
  assert.match(c.hud.innerHTML, /最近一轮实际用量（含输出）：10\.0K/);
});
test('冷却期间保留生成跟踪并安排到期重试，已结束会话也重试归档', async () => {
  const c = capsule(), delays = [];
  c.mounted = true; c.wasRunning = true;
  c.pollTelemetry = async () => {};
  c.updateView = () => {};
  c.schedulePoll = delay => delays.push(delay);
  Object.assign(c.telemetry, { running: true, retryAt: Date.now() + 600000 });
  await c.tick();
  assert.ok(delays.at(-1) > 590000);
  assert.equal(c.wasRunning, true);
  Object.assign(c.telemetry, { running: false, retryAt: 0, archiveRetryAt: Date.now() + 15000 });
  await c.tick();
  assert.ok(delays.at(-1) > 14000);
  // 页面在冷却结束后重新可见，也会恢复采集。
  c.telemetry.archiveRetryAt = Date.now() - 1000;
  c.onVisibility();
  assert.equal(delays.at(-1), 250);
});
test('配额显示为 0% 时不渲染 SVG 进度弧，消除 round linecap 红点残留', () => {
  const c = capsule();
  c.telemetry.quotaReady = true;
  c.telemetry.quota.matchedGroup = 'Claude and GPT models';
  c.telemetry.quota.groups = [
    {
      name: 'Gemini Models',
      buckets: [
        { window: '5h', label: '5h 限额', percent: 91, percentRounded: 91, resetCountdown: '1小时12分钟后重置' },
        { window: 'weekly', label: '周限额', percent: 0.4, percentRounded: 0, resetCountdown: '4天20小时后重置' }
      ]
    },
    {
      name: 'Claude and GPT models',
      buckets: [
        { window: '5h', label: '5h 限额', percent: 0, percentRounded: 0, resetCountdown: '1小时39分钟后重置' },
        { window: 'weekly', label: '周限额', percent: 0, percentRounded: 0, resetCountdown: '6天3小时后重置' }
      ]
    }
  ];
  c.renderHUDContent();
  // 0% 弧段（包括 percent=0.4 但 percentRounded=0 的情况）不应生成 stroke-linecap="round" 的进度圆环
  const progressCircles = [...c.hud.innerHTML.matchAll(/<circle[^>]*stroke-linecap="round"[^>]*>/g)];
  assert.equal(progressCircles.length, 1);
  assert.match(progressCircles[0][0], /r="17"/);
  assert.match(progressCircles[0][0], /stroke="#017ACC"/);
});
