'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, create, createQuotaState, formatCountdown } = require('../src/telemetry');
const row = { chatModel: { model: 'model-a', usage: { inputTokens: '252877', outputTokens: '192' },
  timeToFirstToken: '13.165984333s', streamingDuration: '0.765979042s',
  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000, estimatedTokensUsed: 244966,
    tokenBreakdown: { groups: [{ type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 16567 },
      { type: 'TOKEN_TYPE_TOOLS', numTokens: 9268 }, { type: 'TOKEN_TYPE_CHAT_MESSAGES', children: [
        { name: '0: USER_INPUT', numTokens: 232 }, { name: '1: PLANNER_RESPONSE', numTokens: 477 }, { name: '2: GENERIC', numTokens: 2329 }
      ] }] } } } } };
test('字符串计数、服务端预算、端到端速度和分类使用真实字段', () => {
  const data = analyze(row, [{ modelOrAlias: { model: 'model-a' }, label: '测试模型', quotaInfo: { remainingFraction: 0.9899333, resetTime: { seconds: 1900000000 } } }]);
  assert.equal(data.tokensUsed, 253069);
  assert.equal(data.tokenBudget, 256000);
  assert.equal(data.speedTps, 13.8);
  assert.equal(data.timing.ttft, 13.17);
  assert.equal(data.composition.response, 477);
  assert.equal(data.composition.thinking, null);
  assert.equal(data.quota.percent, 99);
});
test('缺失用量或配额时不编造，关闭明细时不计算分类', () => {
  assert.equal(analyze(null).tokensUsed, null);
  assert.equal(analyze(row, []).quotaReady, false);
  assert.equal(analyze(row, [], false).compositionReady, false);
  const estimate = analyze({ chatModel: { chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 15 } } } });
  assert.equal(estimate.tokensUsed, 15);
  assert.equal(estimate.source, '宿主上下文估算');
});
test('切换会话后丢弃旧请求返回，停用时取消在途请求', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  let resolveFetch, signal;
  global.fetch = async (_, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); };
  try {
    const collector = create(), target = {};
    const pending = collector.poll(target, { quotaPool: false, contextDetailed: true });
    global.location.pathname = '/';
    await collector.poll(target, { quotaPool: false });
    assert.equal(signal.aborted, true);
    resolveFetch({ ok: true, json: async () => ({ trajectory: { generatorMetadata: [row] } }) });
    await pending;
    assert.equal(target.tokensUsed, null);
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('新对话或切换模型时优先使用当前选中模型并正确匹配配额组（Argon 周限额 vs Hydrogen 5h/周双限额）', () => {
  const configs = [
    { modelOrAlias: { model: 'MODEL_H' }, label: 'Gemini 4 Hydrogen (Medium)', quotaInfo: { remainingFraction: 0.87, resetTime: new Date(Date.now() + 170 * 60000).toISOString() } },
    { modelOrAlias: { model: 'MODEL_A' }, label: 'Orchestrator (Argon)', quotaInfo: { remainingFraction: 0.69, resetTime: new Date(Date.now() + 165 * 3600000).toISOString() } }
  ];
  const groups = [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.96, resetTime: new Date(Date.now() + (6 * 24 + 21) * 3600000).toISOString() },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.87, resetTime: new Date(Date.now() + (2 * 60 + 50) * 60000).toISOString() }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: new Date(Date.now() + 7 * 24 * 3600000).toISOString() },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() }
      ]
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [
        { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.69, resetTime: new Date(Date.now() + (6 * 24 + 21) * 3600000).toISOString() }
      ]
    }
  ];
  const argonNew = analyze(null, configs, true, 'Orchestrator (Argon)', groups);
  assert.equal(argonNew.modelName, 'Orchestrator (Argon)');
  assert.equal(argonNew.quotaReady, true);
  assert.equal(argonNew.quota.windowLabel, '周限额');
  assert.equal(argonNew.quota.percent, 69);
  assert.equal(argonNew.quota.groups.length, 3);

  const hydrogenSwitched = analyze(row, configs, true, 'Gemini 4 Hydrogen (Medium)', groups);
  assert.equal(hydrogenSwitched.modelName, 'Gemini 4 Hydrogen (Medium)');
  assert.equal(hydrogenSwitched.quota.windowLabel, '5h 限额');
  assert.equal(hydrogenSwitched.quota.percent, 87);
  assert.equal(hydrogenSwitched.quota.weeklyPercent, 96);

  const claudeSelected = analyze(row, configs, true, 'Claude Sonnet 5.5 (High)', groups);
  assert.equal(claudeSelected.quota.windowLabel, '5h 限额');
  assert.equal(claudeSelected.quota.percent, 100);
  assert.equal(claudeSelected.quota.weeklyPercent, 100);
});
test('跨天倒计时换算为天和小时，小时内保留小时和分钟', () => {
  const dayText = formatCountdown(Date.now() + (6 * 24 + 21) * 3600000 - 1000);
  assert.equal(dayText, '6天21小时后重置');
  const hourText = formatCountdown(Date.now() + (2 * 60 + 50) * 60000 - 1000);
  assert.equal(hourText, '2小时50分钟后重置');
  assert.equal(formatCountdown(undefined), '未上报重置时间');
});
test('新对话无 sessionId 且开启 quotaPool 时也能同步更新配额', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/' };
  global.fetch = async (url) => {
    if (url.includes('GetUserStatus')) {
      return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Orchestrator (Argon)' }] } } }) };
    }
    if (url.includes('RetrieveUserQuotaSummary')) {
      return { ok: true, json: async () => ({ response: { groups: [{ displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.69, resetTime: Date.now() + 3 * 24 * 3600000 }] }] } }) };
    }
    throw new Error('unexpected rpc: ' + url);
  };
  try {
    const collector = create({ quotaState: createQuotaState() }), target = {};
    await collector.poll(target, { quotaPool: true, contextDetailed: true }, null, 'Orchestrator (Argon)', true);
    assert.equal(target.quotaReady, true);
    assert.equal(target.quota.percent, 69);
    assert.equal(target.quota.windowLabel, '周限额');
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('配额接口报错进入 10 分钟熔断，冷却期内不再重复发起请求', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/' };
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const collector = create({ quotaState: createQuotaState() }), target = {};
    await collector.poll(target, { quotaPool: true }, null, null, true);
    assert.equal(calls, 2);
    await collector.poll(target, { quotaPool: true }, null, null, true);
    assert.equal(calls, 2);
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('多实例共享配额缓存与 3 分钟冷却，不重复请求配额接口', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/' };
  let quotaCalls = 0;
  global.fetch = async (url) => {
    if (url.includes('GetUserStatus')) {
      quotaCalls++;
      return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Orchestrator (Argon)' }] } } }) };
    }
    if (url.includes('RetrieveUserQuotaSummary')) {
      return { ok: true, json: async () => ({ response: { groups: [{ displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.72, resetTime: Date.now() + 3 * 24 * 3600000 }] }] } }) };
    }
    throw new Error('unexpected rpc: ' + url);
  };
  try {
    const shared = createQuotaState();
    const c1 = create({ quotaState: shared }), c2 = create({ quotaState: shared });
    const t1 = {}, t2 = {};
    await c1.poll(t1, { quotaPool: true }, null, 'Orchestrator (Argon)', false);
    await c2.poll(t2, { quotaPool: true }, null, 'Orchestrator (Argon)', false);
    assert.equal(quotaCalls, 1);
    assert.equal(t2.quotaReady, true);
    assert.equal(t2.quota.percent, 72);
    c1.stop(); c2.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('轨迹接口遇到 429 限流立即熔断冷却，不再继续轮询', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    const collector = create({ quotaState: createQuotaState() }), target = {};
    await collector.poll(target, { quotaPool: false });
    assert.equal(calls, 1);
    assert.match(target.error, /请求限流/);
    await collector.poll(target, { quotaPool: false });
    assert.equal(calls, 1);
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('缓存命中率计入缓存写入分母且 0 读取时不误报未上报，同时计算纯流式速率', () => {
  const withWrite = {
    chatModel: {
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: '100', outputTokens: '200', responseOutputTokens: '150', cacheReadTokens: '1000', cacheCreationTokens: '900' },
      timeToFirstToken: '4s',
      streamingDuration: '2s',
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000, tokenBreakdown: { groups: [{ type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 500 }] } } }
    }
  };
  const d1 = analyze(withWrite, [], true);
  assert.equal(d1.composition.cacheHitRatio, '50.0%');
  assert.equal(d1.speedTps, 33.3);
  assert.equal(d1.streamSpeedTps, 75);
  assert.equal(d1.durationSec, 6);

  const zeroRead = {
    chatModel: {
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: '500', outputTokens: '50', cacheCreationTokens: '500' },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000, tokenBreakdown: { groups: [{ type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 500 }] } } }
    }
  };
  const d2 = analyze(zeroRead, [], true);
  assert.equal(d2.composition.cacheHitRatio, '0.0%');
});
test('增量轮询跨越多步时回溯拉取全部关联步骤，避免步骤标签退化与归档漏记', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/c/cccccccc-cccc-cccc-cccc-cccccccccccc' };
  const offsets = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (url.includes('GetCascadeTrajectoryGeneratorMetadata')) {
      return {
        ok: true,
        json: async () => ({
          generatorMetadata: [{
            stepIndices: [1],
            chatModel: {
              model: 'm1',
              usage: { inputTokens: '100', outputTokens: '20' },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000, tokenBreakdown: { groups: [{ type: 'TOKEN_TYPE_CHAT_MESSAGES', children: [{ name: '1: GENERIC', numTokens: 300 }] }] } } }
            }
          }]
        })
      };
    }
    if (url.includes('GetCascadeTrajectorySteps')) {
      offsets.push(body.stepOffset);
      const allSteps = [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} },
        { type: 'CORTEX_STEP_TYPE_GENERIC', metadata: { toolCall: { name: 'run_command', argumentsJson: '{}' } } },
        { type: 'CORTEX_STEP_TYPE_GENERIC', metadata: { toolCall: { name: 'read_file', argumentsJson: '{"Path":"/a/b.js"}' } } },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} },
        { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} }
      ];
      return { ok: true, json: async () => ({ steps: allSteps.slice(body.stepOffset) }) };
    }
    if (url.includes('GetCascadeTrajectory')) {
      return {
        ok: true,
        json: async () => ({
          numTotalGeneratorMetadata: 1,
          numTotalSteps: 2,
          trajectory: { generatorMetadata: [], steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', metadata: {} }, { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', metadata: {} }] }
        })
      };
    }
    throw new Error('unexpected: ' + url);
  };
  try {
    const collector = create({ quotaState: createQuotaState() }), target = {};
    await collector.poll(target, { quotaPool: false, contextDetailed: true, history: false });
    await collector.poll(target, { quotaPool: false, contextDetailed: true, history: false });
    assert.deepEqual(offsets, [0, 1]);
    assert.equal(target.sources[0].name, '终端命令');
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
test('配额耗尽省略 remainingFraction 时按 0% 展示，空配额对象不误报', () => {
  const exhausted = analyze(null, [], true, 'Gemini 4 Hydrogen (High)', [{
    displayName: 'Gemini Models',
    buckets: [
      { bucketId: 'gemini-5h', window: '5h', resetTime: new Date(Date.now() + 3600000).toISOString() },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingAmount: '0', resetTime: new Date(Date.now() + 86400000).toISOString() }
    ]
  }]);
  assert.equal(exhausted.quotaReady, true);
  assert.equal(exhausted.quota.percent, 0);
  assert.equal(exhausted.quota.weeklyPercent, 0);

  const disabled = analyze(null, [{ label: 'Gemini 4 Carbon', quotaInfo: {} }], true, 'Gemini 4 Carbon', []);
  assert.equal(disabled.quotaReady, false);
});
test('最新一轮报错无用量时保留上轮有效上下文，并在压缩后续增长后自动退场', () => {
  const errRow = { chatModel: { model: 'm1', error: { message: 'HTTP 429 rate limit' } } };
  const kept = analyze(errRow, [], true, null, [], {}, row);
  assert.equal(kept.tokensUsed, 253069);
  assert.equal(kept.tokenBudget, 256000);
  assert.equal(kept.error, '请求限流');
});
test('压缩触发后在后续轮次恢复增长时自动退场清除提示', async () => {
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = { pathname: '/c/dddddddd-dddd-dddd-dddd-dddddddddddd' };
  let phase = 0;
  const makeRow = (input, checkpoint) => ({
    stepIndices: [phase + 1],
    chatModel: {
      model: 'm1',
      usage: { inputTokens: String(input), outputTokens: '20' },
      chatStartMetadata: { checkpointIndex: checkpoint, contextWindowMetadata: { maxContextTokens: 200000 } }
    }
  });
  global.fetch = async (url) => {
    if (url.includes('GetCascadeTrajectoryGeneratorMetadata')) {
      phase += 1;
      const input = phase === 1 ? 10000 : 12000;
      return { ok: true, json: async () => ({ generatorMetadata: [makeRow(50000, 0), makeRow(input, phase)] }) };
    }
    if (url.includes('GetCascadeTrajectorySteps')) {
      return { ok: true, json: async () => ({ steps: Array.from({ length: phase + 2 }, () => ({ status: 'CORTEX_STEP_STATUS_DONE', type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' })) }) };
    }
    if (url.includes('GetCascadeTrajectory')) {
      return {
        ok: true,
        json: async () => ({
          numTotalGeneratorMetadata: 1,
          numTotalSteps: 2,
          trajectory: { generatorMetadata: [makeRow(50000, 0)], steps: [{ status: 'CORTEX_STEP_STATUS_DONE' }, { status: 'CORTEX_STEP_STATUS_DONE' }] }
        })
      };
    }
    throw new Error('unexpected: ' + url);
  };
  try {
    const collector = create({ quotaState: createQuotaState() }), target = {};
    await collector.poll(target, { quotaPool: false, contextDetailed: false, history: false });
    assert.equal(target.compression, null);
    await collector.poll(target, { quotaPool: false, contextDetailed: false, history: false });
    assert.equal(target.compression.released, 40000);
    await collector.poll(target, { quotaPool: false, contextDetailed: false, history: false });
    assert.equal(target.compression, null);
    collector.stop();
  } finally { global.fetch = originalFetch; global.location = originalLocation; }
});
