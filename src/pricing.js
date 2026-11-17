'use strict';
// USD / 百万 Token；核对 2026-11-16，按请求日期与提示词阶梯选择已公布费率。
const google = 'https://aistudio.google.com/docs/pricing';
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const TIER = '(?: \\((?:X?High|Medium|Low|Orchestrator|Tiered|Thinking)\\))?';
const ID_TIER = '(?:-(?:x?high|medium|low|orchestrator|tiered|thinking))?';
const definitions = [
  [new RegExp(`^(?:Gemini 3\\.[68] Flash${TIER}|gemini-3\\.[68]-flash${ID_TIER})$`, 'i'), [.75,3.75,.075,null], google, { until: '2026-12-31', after: [1.5,7.5,.15,null] }],
  [new RegExp(`^(?:Gemini 4 (?:Carbon|Argon)${TIER}|Orchestrator \\((?:Argon|Carbon)\\)|gemini-4-(?:carbon|argon)${ID_TIER}|(?:MODEL_PLACEHOLDER_)?M668|(?:MODEL_PLACEHOLDER_)?M670|gemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?)$`, 'i'), [2,10,.1,null], google, { until: '2026-11-30', after: [4,20,.2,null] }],
  [new RegExp(`^(?:Gemini 4 Hydrogen${TIER}|gemini-4-hydrogen${ID_TIER})$`, 'i'), [1.5,7.5,.075,null], google],
  [new RegExp(`^(?:Gemini 3\\.1 Pro(?: Preview)?${TIER}|gemini-3\\.1-pro(?:-preview)?${ID_TIER})$`, 'i'), [2,12,.2,null], google, { promptOver200k: [4,18,.4,null] }],
  [new RegExp(`^(?:Gemini 3\\.5 Flash[- ]Lite${TIER}|gemini-3\\.5-flash-lite${ID_TIER})$`, 'i'), [.3,2.5,.03,null], google],
  [new RegExp(`^(?:Gemini 2\\.5 Pro${TIER}|gemini-2\\.5-pro${ID_TIER})$`, 'i'), [1.25,10,.125,null], google, { promptOver200k: [2.5,15,.25,null] }],
  [new RegExp(`^(?:Claude Opus 5\\.5${TIER}|claude-opus-5-5${ID_TIER})$`, 'i'), [4,20,.2,null], anthropic],
  [new RegExp(`^(?:Claude Sonnet 5\\.5${TIER}|claude-sonnet-5-5${ID_TIER})$`, 'i'), [2,10,.1,null], anthropic],
  [/^(?:Claude Sonnet 4\.6(?: \(Thinking\))?|claude-sonnet-4-6)$/i, [3,15,.3,3.75], anthropic],
  [/^(?:Claude Opus 4\.6(?: \(Thinking\))?|claude-opus-4-6)$/i, [5,25,.5,6.25], anthropic]
];
function cost(record) {
  const match = definitions.find(([pattern]) => pattern.test(record.model || ''));
  if (!match) return { usd: null, reason: '模型或公开费率未匹配' };
  const [, baseRates, source, tiers = {}] = match;
  let rates = tiers.until && record.date > tiers.until ? tiers.after : baseRates;
  const promptTokens = (record.input || 0) + (record.cache || 0) + (record.cacheCreate || 0);
  if (tiers.promptOver200k && promptTokens > 200000) rates = tiers.promptOver200k;
  if ((record.cacheCreate || 0) > 0) return { usd: null, reason: '未记录缓存写入 TTL，无法准确选择费率' };
  return { usd: ((record.input || 0)*rates[0] + (record.output || 0)*rates[1] + (record.cache || 0)*rates[2]) / 1e6, source };
}
module.exports = { cost };
