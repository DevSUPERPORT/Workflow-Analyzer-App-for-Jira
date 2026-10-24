// Rovo agent actions ("Workflow Analyst"). Each action returns compact JSON that the
// agent turns into a natural-language answer. Authorization: the calling user must be
// administrator of the requested project (checked asUser), data is read asApp.

import { getProjectBundle, getStatusLoad, getCreatableIssueTypes, createIssue } from './lib/jira.js';
import { getRemediation, addRemediation } from './lib/store.js';
import { simulatePersona, personaFor, compareWorkflows, similarPairs, loadInsights, findingToIssue } from './shared/insights.js';
import { canAdministerProject } from './lib/auth.js';
import * as plans from './lib/plans.js';
import { aiPlan } from './lib/ai.js';
import { modelContext } from './shared/context.js';
import { normalize, allRules } from './shared/engine.js';
import { describeTransition, describeWorkflow, describeRule, describeConditionTree } from './shared/explain.js';
import { findingText, normalizeLang, t as tr } from './shared/i18n.js';

function projectKeyFrom(payload) {
  const k = payload?.projectKey || payload?.context?.jira?.projectKey || payload?.context?.jira?.project?.key;
  return k ? String(k).trim().toUpperCase() : null;
}

async function load(payload) {
  const key = projectKeyFrom(payload);
  if (!key) return { error: 'No project key given and no project in the current context. Ask the user for the Jira project key.' };
  // Authorise first, with the user's own permissions: nothing is read with the app's permissions for a user who is
  // not an admin of the project, and "not found" and "not allowed" give the same answer (no project enumeration).
  const denied = { error: `Project ${key} is not available. Workflow details are only available to administrators of that project or to Jira administrators.` };
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(key) && !/^\d+$/.test(key)) return denied;
  let allowed = false;
  try {
    allowed = await canAdministerProject(key);
  } catch {
    allowed = false;
  }
  if (!allowed) return denied;
  let bundle;
  try {
    bundle = await getProjectBundle(key);
  } catch (e) {
    return e?.status === 404 ? denied : { error: `Could not read project ${key}: ${String(e?.message || e).slice(0, 200)}` };
  }
  return { model: normalize(bundle) };
}

const path = (t) => `${t.from.map((f) => f.name).join(', ') || (t.isInitial ? 'Create' : 'Any status')} → ${t.to?.name || 'same status'}`;

export async function actOverview(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  return {
    project: model.project,
    stats: model.stats,
    workflows: model.workflows.map((wf) => ({
      name: wf.name,
      issueTypes: wf.issueTypes.map((i) => i.name),
      statuses: wf.statuses.map((s) => `${s.name} [${s.category}]`),
      transitions: wf.transitions.length,
      summary: describeWorkflow(model, wf, lang).join(' '),
    })),
    apps: model.vendors.filter((v) => v.thirdParty).map((v) => ({ app: v.name, rules: v.total, conditions: v.condition, validators: v.validator, postFunctions: v.postfunction, transitions: v.transitionCount })),
    topFindings: model.findings.filter((f) => f.severity !== 'info').slice(0, 10).map((f) => ({ severity: f.severity, workflow: f.wfName, transition: f.tName || null, ...findingText(lang, f) })),
  };
}

export async function actFindUsages(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  // One or several terms (comma / semicolon / newline separated), e.g. a list of groups to delete
  const terms = [...new Set(String(payload?.searchTerm || '').split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  if (!terms.length) return { error: 'searchTerm is required.' };
  const type = payload?.objectType ? String(payload.objectType).toLowerCase() : null;
  const results = terms.map((term) => {
    const matches = [];
    for (const [refType, items] of Object.entries(model.index)) {
      if (type && refType !== type) continue;
      for (const e of Object.values(items)) {
        const exact = String(e.name).toLowerCase() === term || String(e.id).toLowerCase() === term;
        if (!exact && !(terms.length === 1 && String(e.name).toLowerCase().includes(term))) continue;
        matches.push({
          type: refType,
          id: e.id,
          name: e.name,
          exists: e.resolved !== false,
          inactive: e.inactive || undefined,
          transitions: e.transitionCount,
          usages: e.usages.slice(0, 60).map((u) => ({ workflow: u.wfName, transition: u.tName, path: u.statusProperty ? `status property of ${u.to}` : `${u.from.join(', ') || '*'} → ${u.to || '↺'}`, ruleType: u.kind, app: u.vendor, parameter: u.via || undefined })),
        });
      }
    }
    return { term, usedInWorkflows: matches.length > 0, matches: matches.slice(0, 20) };
  });
  return {
    project: model.project.key,
    scope: 'Workflow rules, app configurations and transition/status properties of this project. Permission schemes, notification schemes, filters and boards are not covered.',
    results,
    summary: `${results.filter((r) => r.usedInWorkflows).length} of ${results.length} still used in workflows`,
  };
}

export async function actHealth(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  return {
    project: model.project.key,
    healthScore: model.stats.healthScore,
    counts: model.stats.findings,
    findings: model.findings.slice(0, 40).map((f) => ({ severity: f.severity, workflow: f.wfName, transition: f.tName || null, ...findingText(lang, f) })),
  };
}

export async function actExplain(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  const name = String(payload?.transitionName || '').trim().toLowerCase();
  const wfName = String(payload?.workflowName || '').trim().toLowerCase();
  const hits = [];
  for (const wf of model.workflows) {
    if (wfName && !wf.name.toLowerCase().includes(wfName)) continue;
    for (const t of wf.transitions) if (t.name.toLowerCase() === name || (name.length > 2 && t.name.toLowerCase().includes(name))) hits.push({ wf, t });
  }
  if (!hits.length) return { error: `No transition named "${payload?.transitionName}" in project ${model.project.key}.`, availableTransitions: [...new Set(model.workflows.flatMap((w) => w.transitions.map((t) => t.name)))].slice(0, 80) };
  return {
    project: model.project.key,
    results: hits.slice(0, 5).map(({ wf, t }) => ({
      workflow: wf.name,
      transition: t.name,
      id: t.id,
      path: path(t),
      explanation: describeTransition(wf, t, lang, model.findings).join(' '),
      rules: allRules(t).map((r) => ({ type: r.kind, app: r.vendor.name, text: describeRule(r, lang) })),
    })),
  };
}

// ---------------------------------------------------------------- phase 2 actions

export async function actStatusLoad(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  const ids = [...new Set(model.workflows.flatMap((w) => w.statuses.map((s) => s.id)).filter(Boolean))];
  const data = await getStatusLoad(model.project.key, ids, payload?.staleDays || 30);
  const names = new Map(model.workflows.flatMap((w) => w.statuses.map((s) => [s.id, `${s.name} [${s.category}]`])));
  return {
    project: model.project.key,
    openIssues: data.total,
    allIssues: data.all,
    staleDays: data.staleDays,
    statuses: Object.entries(data.byStatus).map(([id, v]) => ({ status: names.get(id) || id, issues: v.count, notUpdatedSinceDays: v.stale, everUsed: v.ever !== 0 })).sort((a, b) => b.issues - a.issues),
    insights: loadInsights(model, data).map((i) => ({ ...i, text: tr(lang, `li.${i.code}`, i) })),
  };
}

export async function actAccess(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const persona = personaFor(null);
  const unknown = [];
  const findRef = (type, name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return Object.values(model.index[type] || {}).find((e) => String(e.name).toLowerCase() === n || String(e.id).toLowerCase() === n) || null;
  };
  for (const g of String(payload?.groupNames || '').split(',').filter((x) => x.trim())) {
    const e = findRef('group', g);
    if (e) persona.groups.add(e.id); else unknown.push(`group ${g.trim()} is not referenced by any workflow condition`);
  }
  for (const r of String(payload?.roleNames || '').split(',').filter((x) => x.trim())) {
    const e = findRef('role', r);
    if (e) persona.roles.add(e.id); else unknown.push(`role ${r.trim()} is not referenced by any workflow condition`);
  }
  persona.reporter = String(payload?.isReporter) === 'true';
  persona.assignee = String(payload?.isAssignee) === 'true';
  const name = String(payload?.transitionName || '').trim().toLowerCase();
  const rows = [];
  for (const wf of model.workflows) {
    const sim = simulatePersona(wf, persona);
    for (const t of wf.transitions) {
      if (name && !t.name.toLowerCase().includes(name)) continue;
      const s = sim[t.key];
      rows.push({ workflow: wf.name, transition: t.name, path: path(t), result: s.state === 'yes' ? 'allowed' : s.state === 'no' ? 'blocked' : 'depends on issue data or app conditions', conditions: describeConditionTree(t.conditions, 'en') || 'none' });
    }
  }
  return { project: model.project.key, persona: { groups: payload?.groupNames || null, roles: payload?.roleNames || null, reporter: persona.reporter, assignee: persona.assignee }, notes: unknown, transitions: rows.slice(0, 80) };
}

export async function actCompare(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const pick = (n) => model.workflows.find((w) => w.name.toLowerCase() === String(n || '').toLowerCase()) || model.workflows.find((w) => w.name.toLowerCase().includes(String(n || '').toLowerCase()));
  const a = pick(payload?.workflowA);
  const b = pick(payload?.workflowB);
  if (!a || !b) {
    const pairs = similarPairs(model.workflows, 60).map((p) => ({ a: p.a.name, b: p.b.name, similarity: p.score }));
    return { error: !a || !b ? 'Workflow not found – available workflows are listed.' : undefined, workflows: model.workflows.map((w) => w.name), similarPairs: pairs };
  }
  const c = compareWorkflows(a, b);
  return {
    similarity: c.score,
    statusesOnlyInA: c.statusesOnlyA.map((s) => s.name),
    statusesOnlyInB: c.statusesOnlyB.map((s) => s.name),
    transitionsOnlyInA: c.transitionsOnlyA.map(path),
    transitionsOnlyInB: c.transitionsOnlyB.map(path),
    transitionsWithDifferentRules: c.transitionsChanged.map((x) => ({ transition: x.a.name, onlyInA: x.rulesOnlyA.map((r) => describeRule(r, 'en')), onlyInB: x.rulesOnlyB.map((r) => describeRule(r, 'en')) })),
    identicalTransitions: c.transitionsSame,
  };
}

export async function actRemediate(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  const sev = String(payload?.minimumSeverity || 'high').toLowerCase();
  const allowed = sev === 'low' ? ['high', 'medium', 'low'] : sev === 'medium' ? ['high', 'medium'] : ['high'];
  const max = Math.min(10, Math.max(1, Number(payload?.maxTasks) || 5));
  const types = await getCreatableIssueTypes(model.project.key);
  const type = types.find((t) => /^(task|aufgabe)$/i.test(t.name)) || types[0];
  if (!type) return { error: 'No issue type available to create tasks in this project.' };
  const existing = await getRemediation(model.project.id);
  const created = [];
  for (const f of model.findings.filter((x) => allowed.includes(x.severity))) {
    if (created.length >= max) break;
    const issue = findingToIssue(f, lang, { projectKey: model.project.key });
    if (existing[issue.fingerprint]) continue;
    const key = await createIssue({ projectKey: model.project.key, issueTypeId: type.id, summary: issue.summary, description: issue.description, labels: ['workflow-health', 'superport-wfa'] });
    created.push({ fingerprint: issue.fingerprint, key, summary: issue.summary });
  }
  if (created.length) await addRemediation(model.project.id, created);
  return { project: model.project.key, issueType: type.name, created: created.map((c) => ({ key: c.key, summary: c.summary })), note: created.length ? undefined : 'No new findings without an existing task.' };
}

// ---------------------------------------------------------------- Autopilot actions (Rovo executes changes)

function planSummary(plan, lang) {
  return {
    planId: plan.id,
    status: plan.status,
    workflow: plan.workflowName,
    sharedWithProjects: plan.sharedProjects.map((p) => p.key),
    operations: plan.results.map((r) => ({ operation: r.op.op, ok: r.ok, result: r.message })),
    changes: plan.changes.slice(0, 40).map((c) => `${c.op} ${c.type} "${c.name}"${c.detail?.rule ? `: ${c.detail.rule}` : c.detail?.field ? ` (${c.detail.field}: ${c.detail.from ?? '-'} -> ${c.detail.to ?? '-'})` : ''}`),
    healthScore: { before: plan.healthBefore, after: plan.healthAfter },
    findingsFixed: plan.fixed.map((f) => findingText(lang, f).title),
    findingsIntroduced: plan.introduced.map((f) => findingText(lang, f).title),
    manualFollowUp: (plan.manual || []).map((f) => findingText(lang, f).title),
    jiraValidation: plan.validation ? { acceptedByJira: plan.validation.ok, errors: plan.validation.errors, warnings: plan.validation.warnings } : undefined,
    errors: plan.errors || undefined,
    warnings: plan.warnings || undefined,
  };
}

async function projectFor(payload) {
  const { model, error } = await load(payload);
  if (error) return { error };
  return { project: { id: model.project.id, key: model.project.key }, model };
}

export async function actPlanChange(payload) {
  const { project, model, error } = await projectFor(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  let ops = null;
  let explanation = '';
  if (payload?.operationsJson) {
    try {
      const parsed = JSON.parse(payload.operationsJson);
      ops = Array.isArray(parsed) ? parsed : parsed.operations;
      explanation = parsed.explanation || '';
    } catch {
      return { error: 'operationsJson is not valid JSON.' };
    }
  } else {
    const bundle = await getProjectBundle(project.id);
    const wf = payload?.workflowName ? model.workflows.find((w) => w.name.toLowerCase().includes(String(payload.workflowName).toLowerCase())) : model.workflows.length === 1 ? model.workflows[0] : null;
    const proposal = await aiPlan({ instructions: payload?.instructions || '', context: modelContext(model, { workflowId: wf?.id, lang, ref: bundle.ref }), lang });
    ops = proposal.operations;
    explanation = proposal.explanation;
    if (!payload?.workflowName && proposal.workflow) payload.workflowName = proposal.workflow;
  }
  if (!ops?.length) return { error: explanation || 'No change operations could be derived from the request. Ask the user for more details.' };
  const plan = await plans.createPlan({ project, workflowName: payload?.workflowName, ops, instructions: payload?.instructions, explanation, source: 'rovo', user: null, lang });
  return { ...planSummary(plan, lang), explanation, nextStep: 'Show this plan to the user. Only after explicit confirmation call apply-workflow-change with this planId.' };
}

export async function actApplyChange(payload) {
  const { project, error } = await projectFor(payload);
  if (error) return { error };
  try {
    const plan = await plans.applyPlan({ project, planId: String(payload?.planId || ''), confirmShared: String(payload?.confirmSharedWorkflow) === 'true', user: null });
    return { ...planSummary(plan, normalizeLang(payload?.language)), rollback: plan.status === 'applied' ? `Can be undone with rollback-workflow-change planId ${plan.id}` : undefined };
  } catch (e) {
    if (e?.code === 'SHARED_CONFIRM') return { error: `${e.message}. Ask the user to confirm the change for all these projects, then call again with confirmSharedWorkflow=true.` };
    return { error: String(e?.message || e) };
  }
}

export async function actRollbackChange(payload) {
  const { project, error } = await projectFor(payload);
  if (error) return { error };
  try {
    return planSummary(await plans.rollbackPlan({ project, planId: String(payload?.planId || ''), confirmOverwrite: String(payload?.confirmOverwrite) === 'true', user: null }), normalizeLang(payload?.language));
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

export async function actAutofix(payload) {
  const { project, model, error } = await projectFor(payload);
  if (error) return { error };
  const lang = normalizeLang(payload?.language);
  const wf = payload?.workflowName ? model.workflows.find((w) => w.name.toLowerCase().includes(String(payload.workflowName).toLowerCase())) : null;
  let plan;
  try {
    plan = await plans.createAutofixPlan({ project, workflowId: wf?.id, user: null, lang });
  } catch (e) {
    if (e?.code === 'NOTHING_TO_FIX') return { error: `${e.message} Suggest plan-workflow-change or remediation tasks for the remaining findings instead.` };
    throw e;
  }
  return { ...planSummary(plan, lang), nextStep: 'Show the plan, then apply it with apply-workflow-change after the user confirms.' };
}

export async function actListPlans(payload) {
  const { project, error } = await projectFor(payload);
  if (error) return { error };
  return { project: project.key, plans: (await plans.listPlans(project.id)).slice(0, 15) };
}
