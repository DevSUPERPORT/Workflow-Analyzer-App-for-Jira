/**
 * In-app AI on Forge LLMs (Claude, runs on Atlassian), so the Copilot works without Rovo. Picks the best
 * available model, answers questions about a workflow and turns a plain-language request into Autopilot
 * operations via a JSON tool schema. Every call passes SUPERPORT's AI budget (Forge variable AI_BUDGET, set through
 * App Status: stop, EUR per month – 20 by default – and the calls / tokens caps, lib/aiBudget.js), the per-site AI
 * switch (off by default, Jira admins turn it on) and this month's meter first, and is priced and counted afterwards.
 *
 * @file        src/lib/ai.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-23
 */

import { chat, list } from '@forge/llm';
import { OPS_JSON_SCHEMA, opsDocumentation } from '../shared/autopilot.js';
import { t, normalizeLang } from '../shared/i18n.js';
import { getAiSettings, getLlmUsage, addLlmUsage, usageMonth } from './store.js';
import { aiBudget, siteBudget, hasSiteCaps, costEur, pricedTokens, STOP_AT } from './aiBudget.js';
import { siteHost } from './jira.js';

const PREFERRED = ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'];
const NO_TEMPERATURE = /claude-(opus|sonnet)-5|claude-opus-4-[78]/;
let cachedModel = null;

export async function pickModel() {
  if (cachedModel) return cachedModel;
  try {
    const res = await list();
    const active = (res?.models || []).filter((m) => m.status !== 'deprecated').map((m) => m.model);
    cachedModel = PREFERRED.find((p) => active.includes(p)) || active.find((m) => /sonnet/.test(m)) || active[0] || PREFERRED[3];
  } catch {
    cachedModel = PREFERRED[3];
  }
  return cachedModel;
}

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || '').join('');
  return '';
}

// ---------------------------------------------------------------- vendor budget, AI switch and monthly quota

const MESSAGE_KEY = { AI_DISABLED: 'ai.off', AI_LIMIT: 'ai.quota', AI_STOPPED: 'ai.stopped' };

/**
 * AI_STOPPED (turned off by SUPERPORT via AI_BUDGET), AI_DISABLED (site switch off) or AI_LIMIT (monthly quota used
 * up), with the user-facing text in the caller's language.
 */
export class AiError extends Error {
  constructor(code, lang = 'en') {
    super(t(lang, MESSAGE_KEY[code] || 'ai.off'));
    this.code = code;
  }
}

export const isAiError = (e) => e instanceof AiError;

/**
 * This site's caps from AI_BUDGET: { stop, callsPerMonth, tokensPerMonth, eurPerMonth, eurPerUsd }. The site host is
 * only looked up when AI_BUDGET has per-site values; if that lookup fails the app-wide values apply.
 */
export async function aiCaps(budget = aiBudget()) {
  if (!hasSiteCaps(budget)) return siteBudget(budget, null);
  let host = null;
  try {
    host = await siteHost();
  } catch (e) {
    console.warn('[ai-budget] site host unknown, app-wide limits apply:', e?.message || e);
  }
  return siteBudget(budget, host);
}

/**
 * Throws AI_STOPPED while SUPERPORT has the AI turned off (for every site, or a cap of 0 for this one), and
 * AI_DISABLED unless a Jira admin switched the AI features on for this site (default: off). The customer's setting
 * is kept either way. Returns this site's caps.
 */
export async function requireAiEnabled(lang) {
  const budget = aiBudget();
  if (budget.stop) throw new AiError('AI_STOPPED', normalizeLang(lang));
  if (!(await getAiSettings()).aiEnabled) throw new AiError('AI_DISABLED', normalizeLang(lang));
  const caps = await aiCaps(budget);
  if (caps.stop) throw new AiError('AI_STOPPED', normalizeLang(lang));
  return caps;
}

/**
 * Usage of the current month against this site's limits (for the admin settings card and the quota check). The EUR
 * budget counts as used up from 98 % (STOP_AT), so a burst of parallel calls can't run far past it.
 */
export async function aiUsage(month = usageMonth(), caps = null) {
  const c = caps || (await aiCaps());
  const u = await getLlmUsage(month);
  const eurLimit = Number.isFinite(c.eurPerMonth) ? c.eurPerMonth : Infinity;
  const spent = eurLimit === Infinity ? false : u.eur >= eurLimit * STOP_AT;
  return { ...u, eur: Math.round(u.eur * 10000) / 10000, limits: { calls: c.callsPerMonth, tokens: c.tokensPerMonth }, eurLimit: eurLimit === Infinity ? null : eurLimit, exhausted: u.calls >= c.callsPerMonth || u.tokens >= c.tokensPerMonth || spent };
}

/** prompt + completion tokens of a Forge LLM response (0 when the response reports no usage). */
export function usageTokens(usage) {
  if (!usage) return 0;
  const io = (Number(usage.input_tokens ?? usage.prompt_tokens) || 0) + (Number(usage.output_tokens ?? usage.completion_tokens) || 0);
  return io || Number(usage.total_tokens) || 0;
}


async function complete(messages, extra = {}, lang = 'en') {
  // Gate and quota are checked before the model is called; the call is counted once it returned
  const caps = await requireAiEnabled(lang);
  const usage = await aiUsage(usageMonth(), caps);
  if (usage.exhausted) throw new AiError('AI_LIMIT', normalizeLang(lang));
  const model = await pickModel();
  const req = { model, messages, max_completion_tokens: 4000, ...extra };
  if (!NO_TEMPERATURE.test(model)) req.temperature = 0.2;
  let res;
  try {
    res = await chat(req);
  } catch (e) {
    // Forge LLMs can be unavailable (region, AI disabled by the org, quota) – say so instead of a stack trace
    cachedModel = null;
    const msg = String(e?.message || e);
    const err = new Error(/forbidden|not enabled|disabled|unavailable|not available|403|quota|limit/i.test(msg) ? `AI is not available on this site right now (${msg.slice(0, 160)}). All non-AI features keep working.` : `AI request failed: ${msg.slice(0, 200)}`);
    err.code = 'AI_UNAVAILABLE';
    throw err;
  }
  const msg = res?.choices?.[0]?.message || {};
  const answerChars = text(msg.content).length + JSON.stringify(msg.tool_calls || '').length;
  const eur = costEur(model, pricedTokens(res?.usage, JSON.stringify(req.messages).length, answerChars), caps.eurPerUsd);
  await addLlmUsage(usage.month, usageTokens(res?.usage), eur).catch((e) => console.error('[ai] usage not recorded', e?.message || e));
  return { res, model };
}

const langName = (l) => (l === 'de' ? 'German' : 'English');

/** Natural language -> structured change operations (tool call). */
export async function aiPlan({ instructions, context, lang = 'en' }) {
  const system = [
    'You are "Workflow Autopilot" by Superport, an expert Jira Cloud workflow administrator.',
    'Translate the administrator request into a precise list of change operations for ONE workflow by calling the tool propose_workflow_changes.',
    'Rules:',
    '- Use only these operations:',
    opsDocumentation(),
    '- Use exact status, transition, group, role, field, screen and resolution names from the context. Prefer transition IDs in "transition" when names are ambiguous.',
    '- Do not invent roles, fields or screens that are not listed. If something required does not exist, leave it out and say so in the explanation.',
    '- The group list can be incomplete on large sites: if the administrator names a group explicitly, use exactly that name (it is verified against Jira before anything is changed). Never guess group names.',
    '- Keep changes minimal and safe. Never remove the create transition.',
    '- "transition" may be a selector: @all, @done (into Done statuses), @global, @initial, @to:<status>, @from:<status>, @name:<text>. Selectors are not allowed for removeTransition/renameTransition.',
    '- Team-managed workflows (marked "team-managed" in the context) set the resolution automatically on Done statuses: never use setResolution there; explain this instead.',
    `- Write "explanation" in ${langName(lang)} (the user's interface language), 2-5 short sentences, mention assumptions. Workflow, status and transition names may be in another language: quote them verbatim, but never switch language because of them. Only if the request itself is written in a different language, answer in that language.`,
    '- If the request is unclear or not possible with the operations, return an empty operations list and explain what is missing.',
  ].join('\n');
  const { res, model } = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: `Context:\n${context}\n\nRequest:\n${instructions}` },
    ],
    {
      tools: [{ type: 'function', function: { name: 'propose_workflow_changes', description: 'Propose change operations for a Jira workflow', parameters: OPS_JSON_SCHEMA } }],
      tool_choice: { type: 'function', function: { name: 'propose_workflow_changes' } },
    },
    lang,
  );
  const msg = res?.choices?.[0]?.message || {};
  const call = (msg.tool_calls || [])[0];
  let parsed = null;
  try {
    const args = call?.function?.arguments;
    parsed = typeof args === 'string' ? JSON.parse(args) : args;
  } catch { /* fall through */ }
  if (!parsed) {
    const m = /\{[\s\S]*\}/.exec(text(msg.content));
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
  }
  if (!parsed) throw new Error('The AI did not return a change plan.');
  return { ...parsed, operations: Array.isArray(parsed.operations) ? parsed.operations : [], model, usage: res?.usage || null };
}

/** Grounded Q&A over the analysis. */
export async function aiAsk({ question, history = [], context, lang = 'en' }) {
  const system = [
    'You are "Workflow Analyst" by Superport inside the Jira app Workflow Analyzer.',
    'Answer questions about the Jira workflows described in the context. Use only facts from the context; say clearly when something is not in the data.',
    `Answer in ${langName(lang)} unless the user writes in another language. Be concise, use short bullet lists, name transitions as "Workflow › Transition".`,
    'When the user wants to change something, describe the change and tell them they can let the Autopilot apply it (Autopilot tab).',
  ].join('\n');
  const msgs = [{ role: 'system', content: `${system}\n\nContext:\n${context}` }];
  for (const h of history.slice(-8)) if (h?.role && h?.content) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 4000) });
  msgs.push({ role: 'user', content: String(question).slice(0, 4000) });
  const { res, model } = await complete(msgs, {}, lang);
  return { answer: text(res?.choices?.[0]?.message?.content), model, usage: res?.usage || null };
}
