const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, create, createQuotaState } = require('../src/telemetry');

const session = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
function row(index = 1, usage = { inputTokens: '100', outputTokens: '20' }) {
  return { stepIndices: [index], chatModel: { model: 'known', usage,
    timeToFirstToken: '2s', streamingDuration: '1s',
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000,
      tokenBreakdown: { groups: [{ type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 100 }] } } } } };
}
function mockRuntime(t) {
  const original = { fetch: global.fetch, now: Date.now, bridge: global.__AGY_KIT_BRIDGE_CLIENT__ };
  let now = 1800000000000;
  Date.now = () => now;
  t.after(() => { global.fetch = original.fetch; Date.now = original.now;
    if (original.bridge === undefined) delete global.__AGY_KIT_BRIDGE_CLIENT__;
    else global.__AGY_KIT_BRIDGE_CLIENT__ = original.bridge; });
  return { advance(ms) { now += ms; } };
}
test('protobuf 省略零值：无缓存为 0%，全缓存输入为 100%，缺少用量仍未知', () => {
  const noCache = analyze(row());
  assert.equal(noCache.composition.cacheHitRatio, '0.0%');
  const allCached = analyze(row(1, { cacheReadTokens: '100', outputTokens: '20' }));
  assert.equal(allCached.composition.cacheHitRatio, '100.0%');
  assert.equal(allCached.tokensUsed, 120);
  assert.equal(allCached.source, '最近一轮实际用量');
  assert.equal(analyze(row(1, {})).composition.cacheHitRatio, '未上报');
  assert.equal(analyze(row(1, {})).tokensUsed, null);
});
test('回复流式速率保留显式零值，并在思考计数可用时扣除思考', () => {
  const usage = { inputTokens: '100', outputTokens: '100', responseOutputTokens: '0', thinkingOutputTokens: '100' };
  assert.equal(analyze(row(1, usage)).streamSpeedTps, 0);
  delete usage.responseOutputTokens;
  assert.equal(analyze(row(1, usage)).streamSpeedTps, 0);
  usage.thinkingOutputTokens = '30';
  assert.equal(analyze(row(1, usage)).streamSpeedTps, 70);
  delete usage.thinkingOutputTokens;
  assert.equal(analyze(row(1, usage)).streamSpeedTps, null);
});
test('生成遇到 429 后保留状态和错误，冷却到期自动恢复采集', async t => {
  const clock = mockRuntime(t);
  let limited = false, calls = 0;
  global.fetch = async url => {
    calls++;
    if (limited) return { ok: false, status: 429 };
    return { ok: true, json: async () => url.endsWith('/GetCascadeTrajectory')
      ? { numTotalSteps: 2, numTotalGeneratorMetadata: 1, trajectory: { generatorMetadata: [row()], steps: [{}, {}] } }
      : url.endsWith('/GetCascadeTrajectorySteps')
        ? { steps: [{}, { status: 'CORTEX_STEP_STATUS_RUNNING', metadata: { createdAt: new Date(Date.now() - 1000).toISOString() }, plannerResponse: { response: '回复' } }] }
        : { generatorMetadata: [row()] } };
  };
  const collector = create({ quotaState: createQuotaState() }), target = {};
  t.after(() => collector.stop());
  const modules = { quotaPool: false, history: false };
  await collector.poll(target, modules, session);
  assert.equal(target.running, true);
  limited = true;
  await collector.poll(target, modules, session);
  const error = target.error, before = calls;
  assert.match(error, /429/);
  await collector.poll(target, modules, session);
  assert.equal(calls, before);
  assert.equal(target.running, true);
  assert.equal(target.liveEstimate, true);
  assert.equal(target.error, error);
  assert.equal(target.retryAt, Date.now() + 600000);
  collector.reanalyze(target, modules, '另一个模型');
  assert.equal(target.running, true);
  assert.equal(target.error, error);
  clock.advance(600001); limited = false;
  await collector.poll(target, modules, session);
  assert.ok(calls > before);
  assert.equal(target.retryAt, 0);
  assert.equal(target.error, '');
});
test('连续归档失败后重读整批未确认记录，恢复后不漏步骤且只推进已落盘游标', async t => {
  const clock = mockRuntime(t), offsets = [], attempts = [];
  let phase = 0, failures = 2;
  const rows = [row(1), row(3), row(5)];
  const steps = Array.from({ length: 6 }, () => ({ metadata: { createdAt: new Date(Date.now()).toISOString() }, status: 'DONE' }));
  global.__AGY_KIT_BRIDGE_CLIENT__ = { async record(id, batch, archiveSteps, offset) {
    assert.equal(id, session);
    for (const r of batch) assert.ok(archiveSteps[r.stepIndices[0] - offset]);
    attempts.push(batch.map(r => r.stepIndices[0]));
    if (failures-- > 0) throw new Error('本地服务断开');
  } };
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    let result;
    if (url.endsWith('/GetCascadeTrajectory')) result = { numTotalSteps: 2, numTotalGeneratorMetadata: 1, trajectory: { generatorMetadata: rows.slice(0, 1), steps: steps.slice(0, 2) } };
    else if (url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      offsets.push(body.generatorMetadataOffset);
      result = { generatorMetadata: rows.slice(body.generatorMetadataOffset, phase + 1) };
    } else result = { steps: steps.slice(body.stepOffset, (phase + 1) * 2) };
    return { ok: true, json: async () => result };
  };
  const collector = create({ quotaState: createQuotaState() }), target = {}, modules = { quotaPool: false, history: true };
  t.after(() => collector.stop());
  await collector.poll(target, modules, session);
  assert.match(target.archiveError, /断开/);
  assert.equal(target.archiveRetryAt, Date.now() + 15000);
  // 冷却期内继续采集新用量，但不能把失败提示抹掉或提前确认落盘。
  phase = 1;
  await collector.poll(target, modules, session);
  assert.equal(attempts.length, 1);
  assert.match(target.archiveError, /断开/);
  clock.advance(15001);
  await collector.poll(target, modules, session);
  phase = 2; clock.advance(15001);
  await collector.poll(target, modules, session);
  assert.deepEqual(attempts, [[1], [1, 3], [1, 3, 5]]);
  assert.equal(target.archiveError, '');
  assert.equal(target.archiveRetryAt, 0);
  await collector.poll(target, modules, session);
  assert.equal(offsets.at(-1), 2);
});
test('归档尚在途时切换会话会安排重试，旧归档完成不污染新会话', async t => {
  mockRuntime(t);
  let finishRecord;
  global.__AGY_KIT_BRIDGE_CLIENT__ = { record: () => new Promise(resolve => { finishRecord = resolve; }) };
  global.fetch = async url => ({ ok: true, json: async () => url.endsWith('/GetCascadeTrajectory')
    ? { numTotalSteps: 2, numTotalGeneratorMetadata: 1, trajectory: { generatorMetadata: [row()], steps: [{}, {}] } }
    : { steps: [{}, { status: 'DONE' }] } });
  const collector = create({ quotaState: createQuotaState() }), target = {}, modules = { quotaPool: false, history: true };
  t.after(() => collector.stop());
  const old = collector.poll(target, modules, session);
  while (!finishRecord) await Promise.resolve();
  await collector.poll(target, modules, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  assert.equal(target.tokensUsed, null);
  assert.equal(target.retryAt, Date.now() + 250);
  finishRecord(); await old;
  assert.equal(target.tokensUsed, null);
  await collector.poll(target, { ...modules, history: false }, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  assert.equal(target.tokensUsed, 120);
  assert.equal(target.retryAt, 0);
});
