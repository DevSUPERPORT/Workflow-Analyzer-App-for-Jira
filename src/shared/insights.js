// Phase 2 analytics: access simulation, path finding, workflow similarity/comparison,
// governance categories, action plan, live load insights, Mermaid export, remediation issues.

import { allRules, flattenConditions } from './engine.js';
import { ruleSignature } from './snapshot.js';
import { t as tr, findingText } from './i18n.js';
import { splitList } from './rules.js';

// ---------------------------------------------------------------- access simulation

/**
 * Evaluate a single condition rule for a persona.
 * persona: { groups:Set, roles:Set, permissions:Set, reporter:bool, assignee:bool, accountId?:string, everyone?:bool }
 * Returns { v: true|false|null, why: string-key }
 */
export function evalCondition(rule, persona) {
  const p = rule.params || {};
  switch (rule.ruleKey) {
    case 'system:restrict-issue-transition': {
      const ids = splitList(p.accountIds);
      const checks = [];
      if (ids.includes('allow-reporter')) checks.push(!!persona.reporter);
      if (ids.includes('allow-assignee')) checks.push(!!persona.assignee);
      const users = ids.filter((x) => x !== 'allow-reporter' && x !== 'allow-assignee');
      if (users.length) checks.push(!!persona.accountId && users.includes(persona.accountId));
      const groups = splitList(p.groupIds);
      if (groups.length) checks.push(groups.some((g) => persona.groups?.has(g)));
      const roles = splitList(p.roleIds);
      if (roles.length) checks.push(roles.some((r) => persona.roles?.has(r)));
      const perms = splitList(p.permissionKeys);
      if (perms.length) checks.push(perms.some((k) => persona.permissions?.has(k)));
      const fieldBased = splitList(p.groupCustomFields).length + splitList(p.allowUserCustomFields).length > 0;
      if (checks.some(Boolean)) return { v: true, why: 'acc.whyMatch' };
      if (fieldBased) return { v: null, why: 'acc.whyFieldBased' };
      return { v: false, why: 'acc.whyNoMatch' };
    }
    case 'system:restrict-from-all-users':
      return { v: false, why: 'acc.whyHidden' };
    default:
      if (rule.disabled) return { v: true, why: 'acc.whyDisabled' };
      return { v: null, why: rule.vendor.thirdParty ? 'acc.whyApp' : 'acc.whyData' };
  }
}

export function evalTree(tree, persona) {
  if (!tree || (!tree.rules.length && !tree.groups.length)) return { v: true, reasons: [] };
  const parts = [
    ...tree.rules.map((r) => ({ ...evalCondition(r, persona), rule: r })),
    ...tree.groups.map((g) => {
      const res = evalTree(g, persona);
      return { v: res.v, why: null, reasons: res.reasons };
    }),
  ];
  const reasons = parts.flatMap((x) => (x.reasons ? x.reasons : [{ v: x.v, why: x.why, rule: x.rule }]));
  if (tree.op === 'ANY') {
    if (parts.some((x) => x.v === true)) return { v: true, reasons };
    if (parts.every((x) => x.v === false)) return { v: false, reasons };
    return { v: null, reasons };
  }
  if (parts.some((x) => x.v === false)) return { v: false, reasons };
  if (parts.every((x) => x.v === true)) return { v: true, reasons };
  return { v: null, reasons };
}

/** Availability of every transition of a workflow for a persona. 'yes' | 'no' | 'maybe' */
export function simulatePersona(wf, persona) {
  const out = {};
  for (const t of wf.transitions) {
    const res = evalTree(t.conditions, persona);
    out[t.key] = { state: res.v === true ? 'yes' : res.v === false ? 'no' : 'maybe', reasons: res.reasons };
  }
  return out;
}

/** Principals (columns) referenced by restrict rules across workflows. */
export function collectPrincipals(workflows) {
  const map = new Map();
  const add = (key, p) => { if (!map.has(key)) map.set(key, p); };
  for (const wf of workflows) {
    for (const t of wf.transitions) {
      for (const r of flattenConditions(t.conditions)) {
        if (r.ruleKey !== 'system:restrict-issue-transition') continue;
        const p = r.params;
        const ids = splitList(p.accountIds);
        if (ids.includes('allow-reporter')) add('reporter', { type: 'reporter', id: 'reporter' });
        if (ids.includes('allow-assignee')) add('assignee', { type: 'assignee', id: 'assignee' });
        for (const ref of r.refs) if (['group', 'role', 'permission', 'user'].includes(ref.type)) add(`${ref.type}:${ref.id}`, { type: ref.type, id: ref.id, name: ref.name, resolved: ref.resolved });
      }
    }
  }
  const order = { reporter: 0, assignee: 1, group: 2, role: 3, permission: 4, user: 5 };
  return [...map.values()].sort((a, b) => order[a.type] - order[b.type] || String(a.name || '').localeCompare(String(b.name || '')));
}

export function personaFor(principal) {
  const p = { groups: new Set(), roles: new Set(), permissions: new Set(), reporter: false, assignee: false, accountId: null };
  if (!principal) return p;
  if (principal.type === 'reporter') p.reporter = true;
  if (principal.type === 'assignee') p.assignee = true;
  if (principal.type === 'group') p.groups.add(principal.id);
  if (principal.type === 'role') p.roles.add(principal.id);
  if (principal.type === 'permission') p.permissions.add(principal.id);
  if (principal.type === 'user') p.accountId = principal.id;
  return p;
}

/** Transition × principal matrix ("who can do what"). */
export function accessMatrix(workflows) {
  const principals = collectPrincipals(workflows);
  const rows = [];
  for (const wf of workflows) {
    for (const t of wf.transitions) {
      const everyone = evalTree(t.conditions, personaFor(null)).v;
      const cells = principals.map((p) => {
        const v = evalTree(t.conditions, personaFor(p)).v;
        return v === true ? 'yes' : v === false ? 'no' : 'maybe';
      });
      rows.push({ wf, t, everyone: everyone === true ? 'yes' : everyone === false ? 'no' : 'maybe', cells });
    }
  }
  return { principals, rows };
}

// ---------------------------------------------------------------- path finder

/** Up to `limit` shortest simple paths from status A to B (refs). Skips transitions in `blocked`. */
export function findPaths(wf, fromRef, toRef, { limit = 3, maxDepth = 10, blocked = new Set() } = {}) {
  const outgoing = new Map();
  const globals = wf.transitions.filter((t) => t.isGlobal && t.to && !blocked.has(t.key));
  for (const t of wf.transitions) {
    if (blocked.has(t.key) || !t.to) continue;
    for (const f of t.from) {
      if (!outgoing.has(f.ref)) outgoing.set(f.ref, []);
      outgoing.get(f.ref).push(t);
    }
  }
  const paths = [];
  const queue = [{ at: fromRef, steps: [], seen: new Set([fromRef]) }];
  while (queue.length && paths.length < limit) {
    const cur = queue.shift();
    if (cur.steps.length >= maxDepth) continue;
    const nexts = [...(outgoing.get(cur.at) || []), ...globals.filter((g) => g.to.ref !== cur.at)];
    for (const t of nexts) {
      const nx = t.to.ref;
      if (cur.seen.has(nx)) continue;
      const steps = [...cur.steps, { t, from: cur.at, to: nx }];
      if (nx === toRef) {
        paths.push(steps);
        if (paths.length >= limit) break;
        continue;
      }
      queue.push({ at: nx, steps, seen: new Set([...cur.seen, nx]) });
    }
    if (queue.length > 20000) break;
  }
  return paths;
}

// ---------------------------------------------------------------- similarity & comparison

const lc = (s) => String(s || '').trim().toLowerCase();
function wfSets(wf) {
  const statuses = new Set(wf.statuses.map((s) => lc(s.name)));
  const transitions = new Set(wf.transitions.map((t) => `${t.from.map((f) => lc(f.name)).sort().join(',') || t.type}>${lc(t.name)}>${lc(t.to?.name)}`));
  const rules = new Set(wf.transitions.flatMap((t) => allRules(t).map((r) => `${lc(t.name)}|${ruleSignature(r)}`)));
  return { statuses, transitions, rules };
}
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

export function similarity(a, b) {
  const A = wfSets(a);
  const B = wfSets(b);
  return Math.round(100 * (0.35 * jaccard(A.statuses, B.statuses) + 0.4 * jaccard(A.transitions, B.transitions) + 0.25 * jaccard(A.rules, B.rules)));
}

/** Pairs of workflows with similarity >= threshold, highest first. */
export function similarPairs(workflows, threshold = 75, max = 50) {
  const pairs = [];
  const sets = workflows.map((w) => ({ w, s: wfSets(w) }));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const A = sets[i].s;
      const B = sets[j].s;
      const score = Math.round(100 * (0.35 * jaccard(A.statuses, B.statuses) + 0.4 * jaccard(A.transitions, B.transitions) + 0.25 * jaccard(A.rules, B.rules)));
      if (score >= threshold) pairs.push({ a: sets[i].w, b: sets[j].w, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, max);
}

/** Structural comparison of two different workflows (matched by names, not IDs). */
export function compareWorkflows(a, b) {
  const sa = new Map(a.statuses.map((s) => [lc(s.name), s]));
  const sb = new Map(b.statuses.map((s) => [lc(s.name), s]));
  const key = (t) => `${lc(t.name)}>${lc(t.to?.name)}`;
  const ta = new Map(a.transitions.map((t) => [key(t), t]));
  const tb = new Map(b.transitions.map((t) => [key(t), t]));
  const out = { statusesOnlyA: [], statusesOnlyB: [], statusesBoth: [], transitionsOnlyA: [], transitionsOnlyB: [], transitionsChanged: [], transitionsSame: 0 };
  for (const [k, s] of sa) (sb.has(k) ? out.statusesBoth : out.statusesOnlyA).push(s);
  for (const [k, s] of sb) if (!sa.has(k)) out.statusesOnlyB.push(s);
  for (const [k, t] of ta) {
    const u = tb.get(k);
    if (!u) { out.transitionsOnlyA.push(t); continue; }
    const fa = t.from.map((f) => lc(f.name)).sort().join(',');
    const fb = u.from.map((f) => lc(f.name)).sort().join(',');
    const ra = new Map(allRules(t).map((r) => [ruleSignature(r), r]));
    const rb = new Map(allRules(u).map((r) => [ruleSignature(r), r]));
    const rulesOnlyA = [...ra].filter(([s]) => !rb.has(s)).map(([, r]) => r);
    const rulesOnlyB = [...rb].filter(([s]) => !ra.has(s)).map(([, r]) => r);
    if (fa !== fb || rulesOnlyA.length || rulesOnlyB.length) out.transitionsChanged.push({ a: t, b: u, fromChanged: fa !== fb, rulesOnlyA, rulesOnlyB });
    else out.transitionsSame++;
  }
  for (const [k, t] of tb) if (!ta.has(k)) out.transitionsOnlyB.push(t);
  out.score = similarity(a, b);
  return out;
}

// ---------------------------------------------------------------- governance & action plan

export const CATEGORY_OF = {
  NO_INITIAL: 'structure', DEAD_END: 'structure', UNREACHABLE: 'structure', DEPRECATED_STATUS: 'structure', DUPLICATE_NAME: 'structure',
  DONE_NO_RESOLUTION: 'data', DONE_RESOLUTION_SCREEN: 'data', REOPEN_KEEPS_RESOLUTION: 'data',
  GLOBAL_UNGUARDED: 'access', HARDCODED_USER: 'access',
  UNRESOLVED_REF: 'integrity', INACTIVE_USER: 'integrity', LICENSE_GUARD: 'integrity',
  COMPLEX: 'maintainability', DISABLED_RULE: 'maintainability', CONFIG_UNREADABLE: 'maintainability', INACTIVE_WORKFLOW: 'maintainability',
};
export const CATEGORIES = ['structure', 'data', 'access', 'integrity', 'maintainability'];
const W = { high: 25, medium: 10, low: 4, info: 1 };

export function governance(model) {
  const res = Object.fromEntries(CATEGORIES.map((c) => [c, { penalty: 0, count: 0 }]));
  for (const f of model.findings) {
    const c = res[CATEGORY_OF[f.code] || 'maintainability'];
    c.penalty += W[f.severity];
    c.count++;
  }
  const scale = Math.max(1, Math.sqrt(Math.max(model.stats.transitions, 1) / 10));
  return CATEGORIES.map((c) => ({ key: c, count: res[c].count, score: Math.max(0, Math.round(100 - res[c].penalty / scale)) }));
}

const EFFORT = { NO_INITIAL: 'M', DEAD_END: 'S', UNREACHABLE: 'S', DEPRECATED_STATUS: 'M', DUPLICATE_NAME: 'S', DONE_NO_RESOLUTION: 'S', DONE_RESOLUTION_SCREEN: 'S', REOPEN_KEEPS_RESOLUTION: 'S', GLOBAL_UNGUARDED: 'S', HARDCODED_USER: 'M', UNRESOLVED_REF: 'S', INACTIVE_USER: 'S', LICENSE_GUARD: 'L', COMPLEX: 'L', DISABLED_RULE: 'S', CONFIG_UNREADABLE: 'M' };
const SEV_RANK = { high: 0, medium: 1, low: 2, info: 3 };

/** Findings grouped into prioritised actions (management summary). */
export function actionPlan(model) {
  const groups = new Map();
  for (const f of model.findings) {
    if (f.severity === 'info') continue;
    const g = groups.get(f.code) || { code: f.code, severity: f.severity, category: CATEGORY_OF[f.code] || 'maintainability', effort: EFFORT[f.code] || 'M', findings: [] };
    if (SEV_RANK[f.severity] < SEV_RANK[g.severity]) g.severity = f.severity;
    g.findings.push(f);
    groups.set(f.code, g);
  }
  const effortRank = { S: 0, M: 1, L: 2 };
  return [...groups.values()]
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || effortRank[a.effort] - effortRank[b.effort] || b.findings.length - a.findings.length)
    .map((g, i) => ({ ...g, priority: g.severity === 'high' ? 'P1' : g.severity === 'medium' ? 'P2' : 'P3', rank: i + 1 }));
}

// ---------------------------------------------------------------- live load insights

/**
 * load: { byStatus: { [statusId]: { count, stale } }, total, staleDays }
 */
export function loadInsights(model, load) {
  const out = [];
  if (!load?.byStatus) return out;
  const total = Math.max(1, load.total || 0);
  for (const wf of model.workflows) {
    const init = wf.transitions.find((t) => t.isInitial)?.to?.ref;
    for (const s of wf.statuses) {
      const l = load.byStatus[s.id];
      if (!l) continue;
      if (s.category !== 'DONE' && l.count >= 5 && l.count / total >= 0.3) out.push({ code: 'BOTTLENECK', severity: 'medium', wfId: wf.id, wfName: wf.name, status: s.name, statusId: s.id, count: l.count, share: Math.round((100 * l.count) / total) });
      if (s.category !== 'DONE' && l.stale >= 3 && l.stale / Math.max(1, l.count) >= 0.5) out.push({ code: 'STALE', severity: 'medium', wfId: wf.id, wfName: wf.name, status: s.name, statusId: s.id, count: l.count, stale: l.stale, days: load.staleDays });
      if (l.count === 0 && l.ever === 0 && s.ref !== init) out.push({ code: 'NEVER_USED', severity: 'low', wfId: wf.id, wfName: wf.name, status: s.name, statusId: s.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------- exports

export function toMermaid(wf) {
  const id = new Map(wf.statuses.map((s, i) => [s.ref, `S${i}`]));
  // Labels must not break the Mermaid syntax or inject markup when rendered
  const q = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n\t]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/;/g, ',').replace(/%%/g, '%').trim() || '(unnamed)';
  const lines = ['stateDiagram-v2', `    %% ${q(wf.name)} – Superport Workflow Analyzer`];
  for (const s of wf.statuses) lines.push(`    ${id.get(s.ref)}: ${q(s.name)}`);
  for (const t of wf.transitions) {
    if (!t.to || !id.has(t.to.ref)) continue;
    const to = id.get(t.to.ref);
    if (t.isInitial) lines.push(`    [*] --> ${to}: ${q(t.name)}`);
    else if (t.isGlobal) for (const s of wf.statuses) { if (s.ref !== t.to.ref) lines.push(`    ${id.get(s.ref)} --> ${to}: ${q(t.name)} (global)`); }
    else for (const f of t.from) if (id.has(f.ref)) lines.push(`    ${id.get(f.ref)} --> ${to}: ${q(t.name)}`);
  }
  for (const s of wf.statuses) if (s.category === 'DONE') lines.push(`    ${id.get(s.ref)} --> [*]`);
  return lines.join('\n');
}

/** Jira issue payload (summary + ADF description) for a remediation task. */
export function findingToIssue(f, lang, extra = {}) {
  const ft = findingText(lang, f);
  const L = (k, v) => tr(lang, k, v);
  const para = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text: String(text), ...(marks ? { marks } : {}) }] });
  const summary = `[${L(`ov.severity.${f.severity}`)}] ${f.wfName}${f.tName ? ` › ${f.tName}` : ''}: ${ft.title}`.slice(0, 250);
  const description = {
    type: 'doc',
    version: 1,
    content: [
      para(ft.title, [{ type: 'strong' }]),
      para(`${L('app.workflow')}: ${f.wfName}${f.tName ? ` › ${f.tName}` : ''}`),
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: L('hc.recommendation') }] },
      para(ft.fix),
      para(`${L('rem.footer')}${extra.projectKey ? ` (${extra.projectKey})` : ''}`, [{ type: 'em' }]),
    ],
  };
  return { summary, description, fingerprint: findingFingerprint(f) };
}

/** Short stable key of a finding (hash of its fingerprint) – compact enough to remember thousands per visit. */
export function findingKey(f) {
  const s = findingFingerprint(f);
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = (Math.imul(31, h2) + s.charCodeAt(i)) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function findingFingerprint(f) {
  // Not the rule ID: Jira regenerates rule IDs on every workflow update (seen live), which would make
  // already created remediation tasks unrecognisable and create duplicates
  return [f.code, f.wfId, f.tKey || '', f.ruleKind || '', f.ruleKey || '', JSON.stringify(f.params || {})].join('|');
}

/** Combine several selected principals ("type:id" keys) into one persona. */
export function personaFromSelection(principals, selected) {
  const p = personaFor(null);
  for (const pr of principals) {
    if (!selected.has(`${pr.type}:${pr.id}`)) continue;
    const one = personaFor(pr);
    one.groups.forEach((g) => p.groups.add(g));
    one.roles.forEach((g) => p.roles.add(g));
    one.permissions.forEach((g) => p.permissions.add(g));
    p.reporter ||= one.reporter;
    p.assignee ||= one.assignee;
    p.accountId ||= one.accountId;
  }
  return p;
}
