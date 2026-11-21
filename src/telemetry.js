/* 同源 LanguageServer RPC 采集；数据结构参考 MIT antigravity-context-viewer。 */
(function (root) {
  'use strict';
  const ns = root[Symbol.for('agy.kit')] || root;
  const insights = typeof module === 'object' && module.exports ? require('./session-insights') : (ns.__AGY_KIT_INSIGHTS__ || root.__AGY_KIT_INSIGHTS__);
  const number = value => value === undefined || value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  function seconds(value) {
    if (typeof value === 'string' && value.endsWith('s')) return number(value.slice(0, -1));
    if (value && typeof value === 'object') return Number(value.seconds || 0) + Number(value.nanos || 0) / 1e9;
    return number(value);
  }
  function timestamp(value) {
    if (value && typeof value === 'object') return Number(value.seconds || 0) * 1000 + Number(value.nanos || 0) / 1e6;
    return typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  }
  function formatCountdown(resetTime) {
    const reset = timestamp(resetTime);
    const mins = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset - Date.now()) / 60000)) : NaN;
    if (!Number.isFinite(mins)) return '未上报重置时间';
    if (mins >= 1440) return `${Math.floor(mins / 1440)}天${Math.floor((mins % 1440) / 60)}小时后重置`;
    return `${Math.floor(mins / 60)}小时${mins % 60}分钟后重置`;
  }
  function empty() {
    return { tokensUsed: null, tokenBudget: null, speedTps: 0, streamSpeedTps: null, durationSec: null, modelName: '新对话 · 尚未生成',
      compositionReady: false, quotaReady: false, source: '', error: '', retryAt: 0, archiveError: '', archiveRetryAt: 0, running: false, liveEstimate: false, sources: [], sourcesOther: null, sourcesTotal: 0, compression: null,
      composition: { system: 0, tools: 0, user: 0, thinking: 0, response: 0, toolResults: 0, cacheHitRatio: '未上报' },
      quota: { percent: null, percentRounded: null, windowLabel: '5h 限额', resetCountdown: null, weeklyPercent: null, weeklyPercentRounded: null, weeklyResetCountdown: null, matchedGroup: null, groups: [] },
      timing: { ttft: null } };
  }
  function extractFraction(obj, allowResetOnly = false) {
    if (!obj || typeof obj !== 'object') return null;
    for (const cand of [obj.remainingFraction, obj.remaining_fraction, obj.fraction]) {
      const n = number(cand);
      if (n !== null) return Math.max(0, Math.min(1, n));
    }
    for (const rawAmt of [obj.remainingAmount, obj.remaining_amount, obj.remaining]) {
      const n = number(rawAmt);
      if (n !== null && n <= 0) return 0;
    }
    if (allowResetOnly && obj.resetTime) return 0;
    return null;
  }
  function parseQuota(modelName, config, quotaGroups) {
    const groups = (Array.isArray(quotaGroups) ? quotaGroups : []).map(g => ({
      name: g.displayName || '',
      buckets: (g.buckets || []).map(b => ({ b, frac: extractFraction(b, true) })).filter(x => x.frac !== null).map(({ b, frac }) => {
        const win = b.window || (/weekly/i.test(b.bucketId || b.displayName || '') ? 'weekly' : '5h');
        return {
          window: win,
          label: win === 'weekly' ? '周限额' : '5h 限额',
          percent: Number((frac * 100).toFixed(1)),
          percentRounded: Math.round(frac * 100),
          resetCountdown: formatCountdown(b.resetTime)
        };
      }).sort((a, b) => (a.window === '5h' ? -1 : 1) - (b.window === '5h' ? -1 : 1))
    })).filter(g => g.buckets.length > 0);

    if (groups.length > 0) {
      const nameStr = String(modelName || '');
      const matched = (/argon/i.test(nameStr) && groups.find(g => /argon/i.test(g.name))) ||
        (/claude|gpt/i.test(nameStr) && groups.find(g => /claude|gpt/i.test(g.name))) ||
        groups.find(g => /gemini\s*models/i.test(g.name)) ||
        groups[0];
      const bucket5h = matched?.buckets.find(b => b.window === '5h') || null;
      const bucketWeekly = matched?.buckets.find(b => b.window === 'weekly') || null;
      const primary = bucket5h || bucketWeekly || matched?.buckets[0];
      if (primary) {
        return {
          ready: true,
          quota: {
            percent: primary.percent,
            percentRounded: primary.percentRounded,
            windowLabel: primary.label,
            resetCountdown: primary.resetCountdown,
            weeklyPercent: bucketWeekly ? bucketWeekly.percent : null,
            weeklyPercentRounded: bucketWeekly ? bucketWeekly.percentRounded : null,
            weeklyResetCountdown: bucketWeekly ? bucketWeekly.resetCountdown : null,
            matchedGroup: matched.name,
            groups
          }
        };
      }
    }

    const quota = config?.quotaInfo;
    const quotaFrac = extractFraction(quota, true);
    if (quotaFrac !== null) {
      const frac = quotaFrac;
      const reset = timestamp(quota.resetTime);
      const mins = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset - Date.now()) / 60000)) : 0;
      const isWeekly = mins >= 1440;
      const percent = Number((frac * 100).toFixed(1));
      const percentRounded = Math.round(frac * 100);
      const resetCountdown = formatCountdown(quota.resetTime);
      return {
        ready: true,
        quota: {
          percent,
          percentRounded,
          windowLabel: isWeekly ? '周限额' : '5h 限额',
          resetCountdown,
          weeklyPercent: isWeekly ? percent : null,
          weeklyPercentRounded: isWeekly ? percentRounded : null,
          weeklyResetCountdown: isWeekly ? resetCountdown : null,
          matchedGroup: null,
          groups: []
        }
      };
    }

    return { ready: false, quota: empty().quota };
  }
  function hasContext(row) {
    const cm = row?.chatModel;
    if (!cm) return false;
    const u = cm.usage || {};
    if (['inputTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(k => number(u[k]) !== null)) return true;
    return number(cm.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed) > 0;
  }
  function analyze(row, configs = [], detailed = true, selectedModel = null, quotaGroups = [], stepLabels = {}, fallbackRow = null) {
    const state = empty();
    const chat = row?.chatModel;
    const findConfig = name => {
      if (!name) return null;
      const clean = String(name).replace(/[()]/g, '');
      return configs.find(c =>
        c.modelOrAlias?.model === name ||
        c.label === name ||
        c.modelId === name ||
        (c.label && c.label.replace(/[()]/g, '') === clean)
      ) || null;
    };
    const config = findConfig(selectedModel) || (chat ? (findConfig(chat.model) || findConfig(chat.modelDisplayName)) : null);
    state.modelName = config?.label || selectedModel || chat?.modelDisplayName || chat?.model || '新对话 · 尚未生成';
    const quotaModel = selectedModel || config?.label || chat?.modelDisplayName || chat?.model || '';
    const quotaResult = parseQuota(quotaModel, config, quotaGroups);
    state.quotaReady = quotaResult.ready;
    state.quota = quotaResult.quota;
    if (!chat && !hasContext(fallbackRow)) return state;

    const failure = chat ? (chat.retryInfos?.at(-1)?.error || chat.error) : null;
    const ctxRow = hasContext(row) ? row : (hasContext(fallbackRow) ? fallbackRow : row);
    const ctxChat = ctxRow?.chatModel;
    if (!ctxChat) {
      state.error = failure ? insights.classify(failure) : '';
      return state;
    }

    const usage = ctxChat.usage || {};
    const context = ctxChat.chatStartMetadata?.contextWindowMetadata;
    const input = number(usage.inputTokens), cached = number(usage.cacheReadTokens) || 0;
    const cacheCreate = number(usage.cacheCreationTokens) || 0;
    const output = number(usage.outputTokens) || 0;
    const promptReported = ['inputTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(key => number(usage[key]) !== null);
    state.tokensUsed = promptReported ? (input || 0) + cached + cacheCreate + output : number(context?.estimatedTokensUsed);
    state.tokenBudget = number(context?.maxContextTokens);
    state.source = promptReported ? '最近一轮实际用量' : '宿主上下文估算';
    const ttft = seconds(ctxChat.timeToFirstToken), stream = seconds(ctxChat.streamingDuration);
    state.timing.ttft = ttft === null ? null : Number(ttft.toFixed(2));
    const totalSec = (ttft || 0) + (stream || 0);
    if (output > 0 && totalSec > 0) {
      state.speedTps = Number((output / totalSec).toFixed(1));
      state.durationSec = Number(totalSec.toFixed(2));
    }
    const thinkingOutput = number(usage.thinkingOutputTokens);
    const respOutput = number(usage.responseOutputTokens)
      ?? (thinkingOutput !== null && number(usage.outputTokens) !== null ? Math.max(0, output - thinkingOutput) : null);
    if (respOutput !== null && stream > 0) state.streamSpeedTps = Number((respOutput / stream).toFixed(1));
    const totalPrompt = (input || 0) + cached + cacheCreate;
    state.composition.cacheHitRatio = promptReported && totalPrompt > 0
      ? `${(cached / totalPrompt * 100).toFixed(1)}%` : '未上报';
    if (detailed && context?.tokenBreakdown?.groups?.length) {
      const c = state.composition;
      for (const g of context.tokenBreakdown.groups) {
        if (g.type === 'TOKEN_TYPE_SYSTEM_PROMPT') c.system += number(g.numTokens) || 0;
        else if (g.type === 'TOKEN_TYPE_TOOLS') c.tools += number(g.numTokens) || 0;
        else if (g.type === 'TOKEN_TYPE_CHAT_MESSAGES') {
          for (const child of g.children || []) {
            const n = number(child.numTokens) || 0;
            if (/USER_INPUT/.test(child.name)) c.user += n;
            else if (/PLANNER_RESPONSE/.test(child.name)) c.response += n;
            else if (/SYSTEM_MESSAGE/.test(child.name)) c.system += n;
            else c.toolResults += n;
          }
        }
      }
      // 宿主历史拆分合并思考与回复，不能把最新一轮比例套用到整段历史。
      c.thinking = null;
      state.compositionReady = true;
    }
    const map = detailed
      ? (insights.sourceMap ? insights.sourceMap(ctxRow, stepLabels) : { items: insights.sources(ctxRow, stepLabels), other: null, total: 0 })
      : { items: [], other: null, total: 0 };
    state.sources = map.items;
    state.sourcesOther = map.other;
    state.sourcesTotal = map.total;
    state.error = failure ? insights.classify(failure) : '';
    return state;
  }
  const QUOTA_MIN_INTERVAL_MS = 180000;
  const QUOTA_FORCE_MIN_GAP_MS = 15000;
  const QUOTA_ERROR_BASE_COOLDOWN_MS = 600000;
  const QUOTA_ERROR_MAX_COOLDOWN_MS = 1800000;
  function createQuotaState() {
    return { configs: [], quotaGroups: [], lastAttemptAt: 0, fetchedAt: 0, cooldownUntil: 0, consecutiveErrors: 0, inFlight: null };
  }
  const defaultQuotaState = createQuotaState();

  function create(options = {}) {
    let stopped = false, busy = false, controller = null, activeId = null;
    let trajCooldownUntil = 0, trajErrors = 0;
    const quotaState = options.quotaState || defaultQuotaState;
    const cache = new Map();
    async function rpc(method, body, signal) {
      const local = new AbortController();
      const onAbort = () => local.abort();
      if (signal?.aborted) local.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => local.abort(), 8000);
      try {
        const response = await fetch('/exa.language_server_pb.LanguageServerService/' + method, {
          method: 'POST', credentials: 'same-origin', signal: local.signal,
          headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': root.__APP_CONFIG__?.csrfToken || '' },
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    async function refreshQuota(force) {
      const now = Date.now();
      if (now < quotaState.cooldownUntil) return;
      if (quotaState.inFlight) return quotaState.inFlight;
      const minGap = force ? QUOTA_FORCE_MIN_GAP_MS : QUOTA_MIN_INTERVAL_MS;
      if (quotaState.lastAttemptAt > 0 && now - quotaState.lastAttemptAt < minGap) return;
      quotaState.lastAttemptAt = now;
      quotaState.inFlight = (async () => {
        try {
          const [u, summary] = await Promise.all([
            rpc('GetUserStatus', {}),
            rpc('RetrieveUserQuotaSummary', { forceRefresh: true }).catch(() => null)
          ]);
          quotaState.configs = u.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
          const groups = summary?.response?.groups || summary?.groups;
          if (Array.isArray(groups)) quotaState.quotaGroups = groups;
          quotaState.fetchedAt = Date.now();
          quotaState.consecutiveErrors = 0;
          quotaState.cooldownUntil = 0;
        } catch {
          if (stopped) return;
          quotaState.consecutiveErrors += 1;
          const backoff = Math.min(QUOTA_ERROR_MAX_COOLDOWN_MS, QUOTA_ERROR_BASE_COOLDOWN_MS * Math.pow(2, quotaState.consecutiveErrors - 1));
          quotaState.cooldownUntil = Date.now() + backoff;
        } finally {
          quotaState.inFlight = null;
        }
      })();
      return quotaState.inFlight;
    }
    return {
      async poll(target, modules, sessionId, selectedModel = null, forceQuota = false, pollOptions = {}) {
        const id = sessionId === undefined ? location.pathname.match(/^\/c\/([a-f0-9-]{36})(?:\/|$)/i)?.[1] || null : sessionId;
        if (id !== activeId) {
          controller?.abort();
          activeId = id;
          trajCooldownUntil = 0;
          trajErrors = 0;
          Object.assign(target, empty());
        }
        if (stopped) return;
        if (busy) {
          if (modules.quotaPool && pollOptions.refreshQuota !== false) {
            await refreshQuota(forceQuota);
            if (!stopped && activeId === id) this.reanalyze(target, modules, selectedModel);
          }
          target.retryAt ||= Date.now() + 250;
          return;
        }
        if (!id && !modules.quotaPool) return;
        busy = true;
        controller = new AbortController();
        try {
          if (modules.quotaPool && pollOptions.refreshQuota !== false) await refreshQuota(forceQuota);
          if (!id) {
            if (stopped || activeId !== id) return;
            const next = analyze(null, quotaState.configs, modules.contextDetailed, selectedModel, quotaState.quotaGroups);
            if (!modules.quotaPool) next.quotaReady = false;
            Object.assign(target, next);
            return;
          }
          if (Date.now() < trajCooldownUntil) {
            const cached = cache.get(id);
            const next = analyze(cached?.row || null, quotaState.configs, modules.contextDetailed, selectedModel, quotaState.quotaGroups, cached?.stepLabels, cached?.validRow || null);
            // 冷却只暂停 RPC；保留上次运行状态、速度及错误，避免调度误判生成结束。
            Object.assign(target, { modelName: next.modelName, quota: next.quota,
              quotaReady: !!modules.quotaPool && next.quotaReady, retryAt: trajCooldownUntil });
            return;
          }
          let entry = cache.get(id);
          const bridgeClient = ns.__AGY_KIT_BRIDGE_CLIENT__ || root.__AGY_KIT_BRIDGE_CLIENT__;
          const shouldArchive = modules.history !== false && bridgeClient && Date.now() >= (entry?.archiveRetryAt || 0);
          let archiveRows = [], archiveSteps = [], archiveOffset = 0, minRowIdx = Infinity;
          if (!entry) {
            const full = await rpc('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 1 }, controller.signal);
            const rows = full.trajectory?.generatorMetadata || [];
            archiveRows = rows; archiveSteps = full.trajectory?.steps || [];
            const totalSteps = Number(full.numTotalSteps || archiveSteps.length || 0);
            archiveOffset = Math.max(0, totalSteps - archiveSteps.length);
            entry = { count: Number(full.numTotalGeneratorMetadata || rows.length), row: rows.filter(r => r.chatModel).at(-1), validRow: rows.filter(hasContext).at(-1) || null, stepCount: totalSteps, archiveCount: 0 };
          } else {
            // 采集游标与已落盘游标分开：失败批次从已确认位置重新读取。
            const metadataOffset = Math.max(0, Math.min(entry.count - 1, shouldArchive ? entry.archiveCount : entry.count - 1));
            const tail = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: metadataOffset, includeMessages: false }, controller.signal);
            const rows = tail.generatorMetadata || [];
            archiveRows = rows;
            const indices = rows.map(r => r.stepIndices?.at(-1)).filter(Number.isInteger);
            if (indices.length) minRowIdx = Math.min(...indices);
            if (rows.length) {
              const validTail = rows.filter(hasContext).at(-1);
              entry = { ...entry, count: metadataOffset + rows.length, row: rows.filter(r => r.chatModel).at(-1) || entry.row, validRow: validTail || entry.validRow || null };
            }
          }
          if (stopped || activeId !== id) return;
          const offset = Math.max(0, Math.min(entry.stepCount - 3, minRowIdx));
          const stepsResult = await rpc('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: offset, trajectoryVerbosity: 3 }, controller.signal);
          trajErrors = 0;
          trajCooldownUntil = 0;
          const steps = stepsResult.steps || [];
          const step = steps.at(-1);
          if (!archiveSteps.length) { archiveSteps = steps; archiveOffset = offset; }
          const stepCount = offset + steps.length;
          if (stepCount < entry.stepCount) { cache.delete(id); Object.assign(target, empty()); return; }
          const progress = insights.track(entry.tracking, { step, index: stepCount - 1, count: entry.count, row: entry.row });
          entry.stepCount = stepCount;
          entry.tracking = progress.state;
          if (progress.compression) {
            entry.compression = { ...progress.compression, count: entry.count, stepCount };
          } else if (entry.compression && (entry.count > entry.compression.count || stepCount > entry.compression.stepCount) && progress.state.input !== null && progress.state.input > entry.compression.after) {
            // 后续轮次恢复增长后自动退场，不永久滞留。
            entry.compression = null;
          }
          if (stopped || activeId !== id) return;
          cache.set(id, entry);
          if (cache.size > 8) cache.delete(cache.keys().next().value);
          entry.stepLabels ||= {};
          const labelStep = (st, idx) => {
            const tool = st.metadata?.toolCall;
            let file = '';
            try { const args = JSON.parse(tool?.argumentsJson || '{}'); file = String(args.Path || args.AbsolutePath || args.TargetFile || '').split('/').pop(); } catch {}
            entry.stepLabels[idx] = tool?.name ? `${tool.name}${file ? ' · ' + file : ''}` : String(st.type || '').replace('CORTEX_STEP_TYPE_', '');
          };
          for (let i = 0; i < archiveSteps.length; i++) labelStep(archiveSteps[i], archiveOffset + i);
          if (archiveSteps !== steps) for (let i = 0; i < steps.length; i++) labelStep(steps[i], offset + i);
          const next = analyze(entry.row, quotaState.configs, modules.contextDetailed, selectedModel, quotaState.quotaGroups, entry.stepLabels, entry.validRow);
          if (entry.compression && next.tokensUsed && next.tokenBudget > 0 && (next.tokensUsed / next.tokenBudget) >= 0.85) {
            entry.compression = null;
          }
          next.running = progress.running;
          next.liveEstimate = progress.liveEstimate;
          if (progress.running) next.speedTps = progress.speedTps || 0;
          next.compression = entry.compression || null;
          if (!modules.quotaPool) next.quotaReady = false;
          Object.assign(target, next, { archiveError: entry.archiveError || '', archiveRetryAt: entry.archiveRetryAt || 0 });
          if (shouldArchive) {
            try {
              await bridgeClient.record(id, archiveRows, archiveSteps, archiveOffset);
              entry.archiveCount = entry.count;
              entry.archiveError = '';
              entry.archiveRetryAt = 0;
            } catch (error) {
              entry.archiveError = error.message;
              entry.archiveRetryAt = Date.now() + 15000;
            }
            if (!stopped && activeId === id) Object.assign(target, { archiveError: entry.archiveError, archiveRetryAt: entry.archiveRetryAt });
          }
        } catch (error) {
          if (!stopped && activeId === id && error.name !== 'AbortError') {
            trajErrors += 1;
            const msg = String(error?.message || '');
            if (/401|403|429|rate.?limit|quota|resource.?exhausted|unauth/i.test(msg)) {
              trajCooldownUntil = Date.now() + 600000;
            } else if (trajErrors >= 2) {
              trajCooldownUntil = Date.now() + Math.min(300000, 60000 * (trajErrors - 1));
            }
            target.error = `${insights.classify(error)}：${error.message}`;
            target.retryAt = trajCooldownUntil;
          }
        } finally { busy = false; }
      },
      reanalyze(target, modules, selectedModel = null) {
        const cached = activeId ? cache.get(activeId) : null;
        const next = analyze(cached?.row || null, quotaState.configs, modules.contextDetailed, selectedModel, quotaState.quotaGroups, cached?.stepLabels, cached?.validRow || null);
        for (const key of ['running', 'liveEstimate', 'compression', 'error', 'retryAt', 'archiveError', 'archiveRetryAt']) next[key] = target[key];
        if (target.liveEstimate) next.speedTps = target.speedTps;
        if (!modules.quotaPool) next.quotaReady = false;
        Object.assign(target, next);
      },
      stop() { stopped = true; controller?.abort(); cache.clear(); }
    };
  }
  const api = { create, createQuotaState, analyze, seconds, timestamp, empty, formatCountdown, parseQuota };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ns.__AGY_KIT_TELEMETRY__ = api;
})(typeof window === 'object' ? window : globalThis);
