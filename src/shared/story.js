/**
 * The plain-language guide to a workflow that every export shows: a verdict, the usual path from creation to done
 * (who may take each step, what Jira checks, what happens automatically and why), the other routes, prioritised
 * improvements with the reason they matter and how to fix them, and a glossary. Pure and deterministic (EN/DE).
 *
 * @file        src/shared/story.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-24
 * @updated     2026-11-24
 */

import { t as tr, findingText } from './i18n.js';
import { describeRule, describeConditionTree, describeWorkflow, ruleTitle } from './explain.js';
import { flattenConditions, allRules, vendorSummary, computeStats, buildIndex } from './engine.js';
import { actionPlan } from './insights.js';

/** Codes the Autopilot can repair by itself (see autofixOperations in autopilot.js) – per finding see canAutofix. */
export const AUTOFIX_CODES = new Set(['DONE_NO_RESOLUTION', 'DONE_CLEARS_RESOLUTION', 'DONE_GENERIC_EVENT', 'REOPEN_KEEPS_RESOLUTION', 'UNRESOLVED_REF', 'INACTIVE_USER', 'DISABLED_RULE']);

/** Same conditions as autofixOperations: only Jira's own rules, only group/role/user references, a known rule. */
export function canAutofix(f) {
  switch (f.code) {
    case 'DONE_NO_RESOLUTION':
    case 'DONE_CLEARS_RESOLUTION':
    case 'DONE_GENERIC_EVENT':
    case 'REOPEN_KEEPS_RESOLUTION':
      return !!f.tKey;
    case 'UNRESOLVED_REF':
      return ['group', 'role', 'user'].includes(f.params?.type) && f.vendor === 'Jira' && f.ruleKind !== 'property';
    case 'INACTIVE_USER':
      return f.vendor === 'Jira' && f.ruleKind !== 'property';
    case 'DISABLED_RULE':
      return !!(f.tKey && f.ruleId);
    default:
      return false;
  }
}

export const GLOSSARY_KEYS = ['status', 'transition', 'condition', 'validator', 'postfunction', 'global', 'resolution', 'screen', 'apps', 'health'];

const REJECT = /reject|ablehn|declin|cancel|abbr|won'?t|nicht erledigt|verwerf|discard|abort|storn/i;

const quote = (lang, s) => (lang === 'de' ? `„${s}“` : `"${s}"`);
const joinList = (lang, items, mode = 'and') => {
  const arr = items.filter(Boolean);
  if (arr.length <= 1) return arr.join('');
  return `${arr.slice(0, -1).join(', ')} ${tr(lang, mode === 'or' ? 'x.or' : 'x.and')} ${arr[arr.length - 1]}`;
};
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const refNames = (rule, type, via) => (rule.refs || []).filter((r) => r.type === type && (!via || r.via === via)).map((r) => r.name);

const isResolutionUpdate = (r) => r.ruleKey === 'system:update-field' && /^resolution$/i.test(String(r.params?.field || ''));

/** Why a single rule exists, in one short sentence (null when nothing useful can be said). */
export function ruleWhy(rule, lang) {
  const L = (k, v) => tr(lang, k, v);
  const p = rule.params || {};
  const fields = (via) => joinList(lang, refNames(rule, 'field', via).map((n) => quote(lang, n))) || '…';
  if (rule.disabled) return L('why.disabled', { rule: quote(lang, ruleTitle(rule, lang)) });
  switch (rule.ruleKey) {
    case 'system:restrict-issue-transition': return L('why.restrict');
    case 'system:check-permission-validator': return L('why.permission', { perm: joinList(lang, refNames(rule, 'permission').map((n) => quote(lang, n))) || '…' });
    case 'system:validate-field-value':
      if (p.ruleType === 'fieldRequired') return L('why.fieldRequired', { fields: fields('fieldsRequired') });
      if (p.ruleType === 'fieldChanged') return L('why.fieldChanged', { fields: fields('fieldKey') });
      if (p.ruleType === 'fieldMatchesRegularExpression' || p.ruleType === 'fieldHasSingleValue') return L('why.fieldRegex', { fields: fields('fieldKey') });
      if (/date/i.test(p.ruleType || '')) return L('why.dateCheck');
      return null;
    case 'system:check-field-value': return L('why.checkField', { field: fields('fieldId') });
    case 'system:previous-status-condition':
    case 'system:previous-status-validator':
      return String(p.not) === 'true' ? null : L('why.prevStatus', { status: joinList(lang, refNames(rule, 'status').map((n) => quote(lang, n)), 'or') || '…' });
    case 'system:parent-or-child-blocking-condition': return L('why.childBlocking');
    case 'system:parent-or-child-blocking-validator': return L('why.parentBlocking');
    case 'system:separation-of-duties': return L('why.separation');
    case 'system:restrict-from-all-users': return L('why.restrictAll');
    case 'system:change-assignee': return L('why.assignee');
    case 'system:copy-value-from-other-field': return L('why.copyField');
    case 'system:update-field': {
      const target = refNames(rule, 'field', 'field')[0] || refNames(rule, 'field')[0] || '';
      if (isResolutionUpdate(rule)) return p.value === '' || p.value == null ? L('why.clearResolution') : L('why.setResolution');
      return L('why.setField', { field: target ? quote(lang, target) : '…' });
    }
    case 'system:trigger-webhook': return L('why.webhook');
    case 'system:trigger-agent': return L('why.agent');
    case 'system:transition-screen': return L('why.screen');
    case 'system:remind-people-to-update-fields': return L('why.remind', { fields: fields('remindingFieldIds') });
    default:
      if (rule.vendor?.thirdParty) return L('why.app', { app: rule.vendor.name });
      return null;
  }
}

/** Kind of a transition for the reader: initial, global, done, back, loop or forward. */
export function transitionRole(wf, t) {
  if (t.isInitial) return 'initial';
  if (t.isLoop) return 'loop';
  if (t.isGlobal) return 'global';
  const cat = (ref) => wf.statuses.find((s) => s.ref === ref)?.category;
  if (cat(t.to?.ref) === 'DONE') return 'done';
  const order = orderOf(wf);
  const to = order.get(t.to?.ref);
  if (to !== undefined && t.from.length && t.from.every((f) => order.has(f.ref) && order.get(f.ref) > to)) return 'back';
  return 'forward';
}

const ORDER = new WeakMap();
const orderOf = (wf) => {
  if (!ORDER.has(wf)) ORDER.set(wf, statusOrder(wf));
  return ORDER.get(wf);
};

/** Distance of each status from the start (BFS over directed and global transitions). */
function statusOrder(wf) {
  const start = wf.transitions.find((t) => t.isInitial)?.to?.ref;
  const dist = new Map();
  if (!start) return dist;
  dist.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const t of wf.transitions) {
      if (t.isInitial || !t.to?.ref || dist.has(t.to.ref)) continue;
      if (t.isGlobal || t.from.some((f) => f.ref === cur)) {
        dist.set(t.to.ref, dist.get(cur) + 1);
        queue.push(t.to.ref);
      }
    }
  }
  return dist;
}

/** Who may take a transition, in words. */
export function whoCanDo(t, lang) {
  const conds = flattenConditions(t.conditions);
  // "Nobody" only when the block applies on its own: a top-level rule of an AND tree (inside an OR group others may pass)
  const top = t.conditions && t.conditions.op !== 'ANY' ? t.conditions.rules : [];
  if (top.some((r) => r.ruleKey === 'system:restrict-from-all-users' && !r.disabled)) return tr(lang, 'g.whoNobody');
  if (!conds.some((r) => !r.disabled)) return tr(lang, t.isInitial ? 'g.whoCreate' : 'g.whoEveryone');
  return cap(describeConditionTree(t.conditions, lang)) || tr(lang, 'g.whoEveryone');
}

/** Everything a reader needs to know about one transition. */
export function explainTransition(model, wf, t, lang) {
  const L = (k, v) => tr(lang, k, v);
  const role = transitionRole(wf, t);
  const checks = t.validators.map((r) => describeRule(r, lang, { phrase: true }));
  const automatic = t.postFunctions.filter((r) => !r.disabled).map((r) => {
    if (isResolutionUpdate(r)) return L(r.params.value === '' || r.params.value == null ? 'g.clearsResolution' : 'g.setsResolution');
    return describeRule(r, lang, { phrase: true });
  });
  const why = [];
  const roleWhy = { initial: 'why.t.initial', global: 'why.t.global', done: 'why.t.done', back: 'why.t.back', loop: 'why.t.loop' }[role];
  if (roleWhy) why.push(L(roleWhy));
  for (const r of allRules(t)) {
    const w = ruleWhy(r, lang);
    if (w) why.push(w);
  }
  const from = t.isInitial ? null : t.isGlobal ? L('g.anyStatus') : joinList(lang, t.from.map((f) => quote(lang, f.name)), 'or');
  const findings = model.findings
    .filter((f) => f.wfId === wf.id && f.tKey === t.key && f.severity !== 'info')
    .map((f) => ({ severity: f.severity, code: f.code, ...findingText(lang, f), matters: L(`why.finding.${f.code}`), autofix: canAutofix(f) }));
  return {
    key: t.key,
    id: t.id,
    name: t.name,
    role,
    from,
    to: t.to?.name || null,
    who: whoCanDo(t, lang),
    screen: t.screen?.name ? L('g.form', { screen: t.screen.name }) : null,
    checks,
    automatic,
    apps: uniq(allRules(t).filter((r) => r.vendor?.thirdParty).map((r) => r.vendor.name)),
    why: uniq(why),
    findings,
  };
}

/**
 * The usual path: shortest route from the create transition to a Done status, avoiding global and
 * "reject/cancel"-like transitions when another route exists.
 */
export function mainPath(wf) {
  const init = wf.transitions.find((t) => t.isInitial);
  if (!init?.to?.ref) return null;
  const doneStatuses = wf.statuses.filter((s) => s.category === 'DONE');
  const allDone = new Set(doneStatuses.map((s) => s.ref));
  // A "Rejected"/"Cancelled" Done status is not where work normally ends – prefer the others when there are any
  const goodDone = new Set(doneStatuses.filter((s) => !REJECT.test(s.name)).map((s) => s.ref));
  const rejecting = (t) => REJECT.test(t.name) || REJECT.test(t.to?.name || '');
  const search = (targets, { allowReject, globals }) => {
    if (targets.has(init.to.ref)) return [];
    const prev = new Map([[init.to.ref, null]]);
    const queue = [init.to.ref];
    while (queue.length) {
      const cur = queue.shift();
      if (targets.has(cur)) {
        const steps = [];
        for (let r = cur; prev.get(r); r = prev.get(r).from) steps.unshift(prev.get(r).t);
        return steps;
      }
      // Directed steps first, global ones ("from any status") only when allowed, reject-like ones last
      const out = wf.transitions
        .filter((t) => !t.isInitial && !t.isLoop && t.to?.ref && t.to.ref !== cur && (allowReject || !rejecting(t)) && (t.isGlobal ? globals : t.from.some((f) => f.ref === cur)))
        .sort((a, b) => Number(a.isGlobal) - Number(b.isGlobal) || Number(rejecting(a)) - Number(rejecting(b)));
      for (const t of out) {
        if (prev.has(t.to.ref)) continue;
        prev.set(t.to.ref, { from: cur, t });
        queue.push(t.to.ref);
      }
    }
    return null;
  };
  const attempts = [
    [goodDone, { allowReject: false, globals: false }],
    [goodDone, { allowReject: false, globals: true }],
    [goodDone, { allowReject: true, globals: true }],
    [allDone, { allowReject: true, globals: true }],
  ];
  for (const [targets, opts] of attempts) {
    if (!targets.size) continue;
    const steps = search(targets, opts);
    if (steps) return [init, ...steps];
  }
  return null;
}

function verdictOf(findings) {
  const relevant = findings.filter((f) => f.severity !== 'info');
  const hi = relevant.filter((f) => f.severity === 'high').length;
  const n = relevant.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  if (hi) return { level: 'critical', hi, n: relevant.length };
  if (n) return { level: 'attention', hi: 0, n };
  return { level: 'good', hi: 0, n: 0 };
}

export function verdictText(v, lang) {
  return tr(lang, `g.verdict.${v.level}`, { hi: v.hi, n: v.n });
}

/** Improvements for one workflow (or the whole model with wf = null), most important first. */
export function improvements(model, wf, lang, { limit = 0 } = {}) {
  const sub = wf ? { ...model, findings: model.findings.filter((f) => f.wfId === wf.id) } : model;
  const plan = actionPlan(sub).map((g) => {
    const first = g.findings[0];
    const where = uniq(g.findings.map((f) => (wf ? f.tName || '' : `${f.wfName}${f.tName ? ` › ${f.tName}` : ''}`) || f.params?.status || f.params?.name || ''));
    return {
      code: g.code,
      priority: g.priority,
      severity: g.severity,
      effort: g.effort,
      effortText: tr(lang, `g.effort.${g.effort}`),
      count: g.findings.length,
      title: tr(lang, `plan.action.${g.code}`),
      matters: tr(lang, `why.finding.${g.code}`),
      fix: findingText(lang, first).fix,
      where,
      // 'all' / 'some' / false – the Autopilot only repairs Jira's own rules (see canAutofix)
      autofix: g.findings.every(canAutofix) ? 'all' : g.findings.some(canAutofix) ? 'some' : false,
    };
  });
  return limit ? plan.slice(0, limit) : plan;
}

/** Other routes besides the usual path, grouped by kind. */
function otherRoutes(model, wf, lang, onPath) {
  return wf.transitions
    .filter((t) => !t.isInitial && !onPath.has(t.key))
    .map((t) => {
      const x = explainTransition(model, wf, t, lang);
      const kind = t.isGlobal ? 'global' : x.role === 'back' ? 'back' : x.role === 'done' ? 'done' : 'side';
      return { ...x, kind, kindText: tr(lang, `g.other.${kind}`) };
    })
    .sort((a, b) => ['done', 'back', 'global', 'side'].indexOf(a.kind) - ['done', 'back', 'global', 'side'].indexOf(b.kind));
}

/** The whole guide for one workflow. */
export function workflowStory(model, wf, lang = 'en') {
  const path = mainPath(wf);
  const onPath = new Set((path || []).map((t) => t.key));
  const journey = (path || []).map((t, i) => ({ n: i + 1, ...explainTransition(model, wf, t, lang) }));
  const end = path?.length ? path[path.length - 1].to?.name : null;
  const findings = model.findings.filter((f) => f.wfId === wf.id);
  const verdict = verdictOf(findings);
  return {
    id: wf.id,
    name: wf.name,
    summary: describeWorkflow(model, wf, lang),
    verdict: { ...verdict, text: verdictText(verdict, lang) },
    journey,
    journeyEnd: end ? tr(lang, 'g.journey.end', { status: end }) : null,
    others: otherRoutes(model, wf, lang, onPath),
    improvements: improvements(model, wf, lang),
    transitions: wf.transitions.map((t) => ({ ...explainTransition(model, wf, t, lang), onPath: onPath.has(t.key) })),
  };
}

/** Site- or project-level summary: verdict and the most important improvements across all workflows. */
export function siteStory(model, lang = 'en', { top = 5 } = {}) {
  const verdict = verdictOf(model.findings);
  return { verdict: { ...verdict, text: verdictText(verdict, lang) }, top: improvements(model, null, lang, { limit: top }) };
}

/**
 * What an export covers: the findings, apps and statistics of the chosen workflows (and, for "export selection",
 * only the chosen transitions) – so a one-workflow export does not show the score and apps of the whole site.
 */
export function exportScope(model, workflows, onlyKeys = null) {
  const only = onlyKeys ? new Set(onlyKeys) : null;
  const ids = new Set(workflows.map((w) => w.id));
  const findings = model.findings.filter((f) => ids.has(f.wfId) && (!only || !f.tKey || only.has(f.tKey)));
  const wfs = only ? workflows.map((wf) => ({ ...wf, transitions: wf.transitions.filter((t) => only.has(t.key)) })).filter((wf) => wf.transitions.length) : workflows;
  const vendors = vendorSummary({ workflows: wfs });
  const index = buildIndex({ workflows: wfs });
  const stats = computeStats({ workflows: wfs, findings, vendors, index });
  stats.rules = stats.condition + stats.validator + stats.postfunction;
  return { findings, vendors, stats, index, workflows: wfs };
}

export function exportGlossary(lang = 'en') {
  return GLOSSARY_KEYS.map((k) => ({ key: k, term: tr(lang, `gl.${k}`), text: tr(lang, `gl.${k}.text`) }));
}
