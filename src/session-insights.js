/* 按会话和请求跟踪生成状态；不把撤销或模型切换当作压缩。 */
(function (root) {
  'use strict';
  const uuid = /^[a-f\d]{8}-[a-f\d-]{27}$/i;
  function resolveSession(footer) {
    let f = footer?.[Object.keys(footer).find(k => k.startsWith('__reactFiber$'))];
    for (let depth = 0; f && depth < 65; depth++, f = f.return) {
      const p = f.memoizedProps;
      for (const key of ['cascadeId', 'effectiveCascadeId', 'conversationId', 'data-cascade-id']) {
        if (uuid.test(p?.[key] || '')) return p[key];
      }
    }
    if (document.querySelectorAll('.agy-composer-footer, [class*="composer-footer"]').length === 1) {
      return location.pathname.match(/^\/c\/([a-f\d-]{36})/i)?.[1] || null;
    }
    return null;
  }
  function classify(error) {
    const message = String(error?.message || error || '');
    if (/context.*(limit|long|exceed)|too many tokens|上下文/i.test(message)) return '上下文超限';
    if (/quota|resource.exhausted|配额/i.test(message)) return '配额耗尽';
    if (/429|rate.limit|限流/i.test(message)) return '请求限流';
    if (/401|403|unauth|permission.denied/i.test(message)) return '认证或权限异常';
    if (/abort|cancel/i.test(message)) return '请求已取消或超时';
    if (/fetch|network|connect|offline|timeout/i.test(message)) return '网络连接异常';
    return message ? '请求异常' : '';
  }
  const SYSTEM_LABELS = {
    skills: '系统 · 技能规则',
    subagents: '系统 · 子智能体定义',
    featured_plugins: '系统 · 推荐插件',
    user_rules: '系统 · 用户规则',
    artifacts: '系统 · 产物规范',
    guidelines: '系统 · 行为规范',
    communication_style: '系统 · 表达规范',
    conversation_transcript: '系统 · 转录规范',
    slash_commands: '系统 · 斜杠命令',
    messaging: '系统 · 消息机制',
    mcp_servers: '系统 · MCP 服务',
    identity: '系统 · 身份定义',
    user_information: '系统 · 环境信息'
  };
  const STEP_LABELS = {
    PLANNER_RESPONSE: '助手回复与思考',
    USER_INPUT: '用户提问',
    SYSTEM_MESSAGE: '系统消息',
    CHECKPOINT: '检查点摘要',
    EPHEMERAL_MESSAGE: '临时上下文',
    GENERIC: '工具调用与结果'
  };
  const TOOL_VERBS = {
    read_file: '读取',
    view_file: '查看',
    write_file: '写入',
    edit_file: '编辑',
    replace_file_content: '编辑',
    multi_replace_file_content: '批量编辑',
    run_command: '终端命令',
    search_web: '网页搜索',
    grep_search: '代码搜索',
    find_by_name: '查找文件',
    list_dir: '列出目录'
  };
  function formatSource(group, rawName, stepLabels) {
    const name = String(rawName || '');
    if (group?.type === 'TOKEN_TYPE_SYSTEM_PROMPT' || group?.name === 'System Prompt') {
      return { label: SYSTEM_LABELS[name] || `系统 · ${name}`, category: 'system' };
    }
    if (group?.type === 'TOKEN_TYPE_TOOLS' || group?.name === 'Tools') {
      return { label: name, category: 'tools' };
    }
    const match = name.match(/^(\d+):\s*(.+)$/);
    if (match) {
      const idx = Number(match[1]), stepType = match[2].trim();
      const resolved = stepLabels?.[idx];
      if (resolved) {
        if (STEP_LABELS[resolved]) {
          const cat = resolved === 'USER_INPUT' ? 'user' : resolved === 'PLANNER_RESPONSE' ? 'response' : resolved === 'SYSTEM_MESSAGE' ? 'system' : 'results';
          return { label: STEP_LABELS[resolved], category: cat };
        }
        const parts = String(resolved).split(' · ');
        const verb = TOOL_VERBS[parts[0]];
        return { label: verb ? (parts[1] ? `${verb} · ${parts[1]}` : verb) : resolved, category: 'results' };
      }
      const cat = stepType === 'USER_INPUT' ? 'user' : stepType === 'PLANNER_RESPONSE' ? 'response' : stepType === 'SYSTEM_MESSAGE' ? 'system' : 'results';
      return { label: STEP_LABELS[stepType] || stepType, category: cat };
    }
    return { label: STEP_LABELS[name] || SYSTEM_LABELS[name] || name, category: 'results' };
  }
  function sourceMap(row, stepLabels = {}) {
    const groups = row?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups || [];
    const merged = new Map();
    for (const group of groups) {
      const children = group.children || [];
      if (!children.length && Number(group.numTokens) > 0) {
        const tokens = Number(group.numTokens);
        const { label, category } = formatSource(group, group.name || group.type, stepLabels);
        const key = `${category}:${label}`;
        const prev = merged.get(key);
        if (prev) { prev.tokens += tokens; prev.count += 1; }
        else merged.set(key, { group: group.name, category, name: label, tokens, count: 1 });
        continue;
      }
      for (const child of children) {
        const tokens = Number(child.numTokens || 0);
        if (tokens <= 0) continue;
        const { label, category } = formatSource(group, child.name, stepLabels);
        const key = `${category}:${label}`;
        const prev = merged.get(key);
        if (prev) { prev.tokens += tokens; prev.count += 1; }
        else merged.set(key, { group: group.name, category, name: label, tokens, count: 1 });
      }
    }
    const sorted = [...merged.values()].sort((a, b) => b.tokens - a.tokens);
    const total = sorted.reduce((s, x) => s + x.tokens, 0);
    const items = sorted.slice(0, 5);
    const rest = sorted.slice(5);
    const restTokens = rest.reduce((s, x) => s + x.tokens, 0);
    const other = restTokens > 0 ? { group: 'Other', category: 'other', name: `其余 ${rest.length} 项`, tokens: restTokens, count: rest.length } : null;
    return { items, other, total };
  }
  function sources(row, stepLabels = {}) {
    return sourceMap(row, stepLabels).items;
  }
  function estimate(text) {
    // 中日韩字符约一字一个 Token，其余文本约四字符一个；不含不可见思考。
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(cjk + (text.length - cjk) / 4);
  }
  function track(previous, snapshot) {
    const { step, index, count, row } = snapshot;
    const p = step?.plannerResponse;
    const meta = step?.metadata || {};
    const running = /GENERATING|RUNNING/.test(step?.status || '');
    const key = p?.messageId || `${meta.executionId || ''}:${index}`;
    const visible = estimate((typeof p?.thinking === 'string' ? p.thinking : '') + (p?.modifiedResponse || p?.response || ''));
    const start = Date.parse(meta.createdAt);
    const elapsed = Math.max(.001, (Date.now() - start) / 1000);
    const result = { running, liveEstimate: running, speedTps: running && Number.isFinite(start) ? Math.round(visible / elapsed * 10) / 10 : null };
    const usage = row?.chatModel?.usage;
    const model = row?.chatModel?.model;
    const input = usage && (usage.inputTokens !== undefined || usage.cacheReadTokens !== undefined) ? Number(usage.inputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.cacheCreationTokens || 0) : null;
    const checkpoint = row?.chatModel?.chatStartMetadata?.checkpointIndex;
    const monotonic = previous && count >= previous.count && index >= previous.index && model === previous.model;
    const advanced = monotonic && Number.isFinite(checkpoint) && checkpoint >= 0 && checkpoint > (previous.checkpoint ?? -1);
    const drop = previous?.input - input;
    const isDrop = advanced && input !== null && previous.input > 0 && drop > 5000 && (drop / previous.input) >= 0.25;
    result.compression = isDrop ? { before: previous.input, after: input, released: drop } : null;
    result.state = { key, count, index, model, input: input ?? previous?.input ?? null, checkpoint: input === null ? previous?.checkpoint : checkpoint };
    return result;
  }
  function resolveModel(footer) {
    if (!footer) return null;
    const anchor = footer.querySelector?.('button[aria-label^="Select model"], button[data-testid="model-selector-trigger"]') || footer;
    const key = Object.keys(anchor).find(k => k.startsWith('__reactFiber$'));
    let f = key ? anchor[key] : null;
    for (let depth = 0; f && depth < 65; depth++, f = f.return) {
      const m = f.memoizedProps?.selectedModel;
      if (m && (m.label || m.modelId || m.value)) return m.label || m.modelId || m.value;
      for (let c = f.dependencies?.firstContext; c; c = c.next) {
        const cm = c.memoizedValue?.selectedModel;
        if (cm && (cm.label || cm.modelId || cm.value)) return cm.label || cm.modelId || cm.value;
      }
    }
    return footer.querySelector?.('button[aria-label^="Select model"], button[data-testid="model-selector-trigger"]')?.textContent?.trim() || null;
  }
  function squarify(list, w, h) {
    const sized = [...(list || [])].filter(b => b && b.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    const sum = sized.reduce((s, x) => s + x.tokens, 0);
    if (!sum || w <= 0 || h <= 0) return [];
    const scale = (w * h) / sum;
    const entries = sized.map(it => ({ it, a: it.tokens * scale }));
    const out = [];
    let rem = { x: 0, y: 0, w, h }, row = [];
    const worst = (areas, side) => {
      const s = areas.reduce((a, b) => a + b, 0), t = s / side;
      return Math.max(0, ...areas.map(a => { const l = a / t; return l > t ? l / t : t / l; }));
    };
    const flush = () => {
      const s = row.reduce((a, r) => a + r.a, 0);
      if (rem.w >= rem.h) {
        const t = s / rem.h; let y = rem.y;
        for (const r of row) { const l = r.a / t; out.push({ item: r.it, rect: { x: rem.x, y, w: t, h: l } }); y += l; }
        rem = { x: rem.x + t, y: rem.y, w: rem.w - t, h: rem.h };
      } else {
        const t = s / rem.w; let x = rem.x;
        for (const r of row) { const l = r.a / t; out.push({ item: r.it, rect: { x, y: rem.y, w: l, h: t } }); x += l; }
        rem = { x: rem.x, y: rem.y + t, w: rem.w, h: rem.h - t };
      }
      row = [];
    };
    for (const entry of entries) {
      if (row.length > 0 && worst([...row.map(r => r.a), entry.a], Math.min(rem.w, rem.h)) > worst(row.map(r => r.a), Math.min(rem.w, rem.h))) flush();
      row.push(entry);
    }
    if (row.length > 0) flush();
    return out;
  }
  const api = { resolveSession, resolveModel, classify, sources, sourceMap, squarify, estimate, track };
  const ns = root[Symbol.for('agy.kit')] || root;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ns.__AGY_KIT_INSIGHTS__ = api;
})(typeof window === 'object' ? window : globalThis);
