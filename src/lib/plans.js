/**
 * Workflow Autopilot backend: change plans with dry run, validated apply via the Jira bulk workflow update API,
 * automatic backup and one-click, conflict-aware rollback. Applies are locked against double clicks and re-run
 * on the latest workflow version.
 *
 * @file        src/lib/plans.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import { route } from '@forge/api';
import { jira, getProjectBundle, getWorkflowProjects, getWorkflowBundle, ensureGroups, workflowUsageMap } from './jira.js';
import { isJiraAdmin, canAdministerProject, ForbiddenError } from './auth.js';
import * as store from './store.js';
import { normalize } from '../shared/engine.js';
import { dryRun, applyOperations, buildUpdatePayload, autofixOperations, removedStatusMigrations, normalizeOp } from '../shared/autopilot.js';
import { makeSnapshot, chunkString } from '../shared/snapshot.js';
import { findingFingerprint } from '../shared/insights.js';

const MAX_PLANS = 50; // per project
const MAX_SITE_PLANS = 400; // site-wide bulk changes create one plan per workflow (max. 200 per bulk)
const KEEP_APPLIED_MS = 90 * 24 * 3600 * 1000; // applied plans stay rollback-able this long
export const MAX_OPS = 60;
const PLAN_TTL_MS = 7 * 24 * 3600 * 1000;
const planKey = (id) => `plan-${id}`;
const idxKey = (projectId) => `plans-${projectId}`;

const slimFinding = (f) => ({ id: f.id, code: f.code, severity: f.severity, wfName: f.wfName, tName: f.tName || null, params: f.params || null, ruleLabel: f.ruleLabel || null, vendor: f.vendor || null });
const cleanOps = (ops) => (ops || []).map((o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_'))));

/**
 * Version-independent fingerprint of a workflow's content. Jira bumps the version more than once for one
 * update when statuses are removed (definition + issue migration – seen live), so versions cannot tell
 * whether someone else changed the workflow; the content can.
 */
export function workflowSignature(wf) {
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  const rules = (list) => (list || []).map((r) => [r.ruleKey, sortKeys(r.parameters || {})]);
  const cond = (g) => (g ? { op: g.operation, c: rules(g.conditions), g: (g.conditionGroups || []).map(cond) } : null);
  const body = {
    statuses: (wf?.statuses || []).map((s) => [String(s.statusReference), sortKeys(s.properties || {})]).sort((a, b) => a[0].localeCompare(b[0])),
    transitions: (wf?.transitions || [])
      .map((t) => [String(t.id), t.name, t.type, String(t.toStatusReference ?? ''), (t.links || []).map((l) => String(l.fromStatusReference)).sort(), cond(t.conditions), rules(t.validators), rules(t.actions), rules(t.triggers), sortKeys(t.properties || {}), t.transitionScreen?.parameters?.screenId || null])
      .sort((a, b) => a[0].localeCompare(b[0])),
  };
  const s = JSON.stringify(body);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

async function deletePlanData(id) {
  const old = await kvs.get(planKey(id));
  for (let i = 0; i < (old?.backupChunks || 0); i++) await kvs.delete(`planbak-${id}-${i}`);
  await kvs.delete(planKey(id));
}

async function savePlan(plan) {
  await kvs.set(planKey(plan.id), plan);
  const idx = (await kvs.get(idxKey(plan.projectId))) || [];
  const entry = { id: plan.id, status: plan.status, createdAt: plan.createdAt, createdBy: plan.createdBy || null, workflowName: plan.workflowName, source: plan.source, title: plan.title, opCount: plan.ops.length, healthBefore: plan.healthBefore, healthAfter: plan.healthAfter };
  const next = [entry, ...idx.filter((e) => e.id !== plan.id)];
  const removed = [];
  const max = plan.projectId === SITE.id ? MAX_SITE_PLANS : MAX_PLANS;
  // Evict the oldest plans first, but keep recently applied ones (their rollback) unless the index would explode
  const protectedEntry = (e) => (e.status === 'applied' || e.status === 'applying') && Date.now() - new Date(e.createdAt).getTime() < KEEP_APPLIED_MS;
  for (let i = next.length - 1; i > 0 && next.length > max; i--) if (!protectedEntry(next[i])) removed.push(...next.splice(i, 1));
  if (next.length > max * 2) removed.push(...next.splice(max * 2));
  await kvs.set(idxKey(plan.projectId), next);
  for (const r of removed) await deletePlanData(r.id);
  return plan;
}

export async function listPlans(projectId) {
  return (await kvs.get(idxKey(projectId))) || [];
}

export async function getPlan(projectId, id) {
  const plan = await kvs.get(planKey(String(id)));
  if (!plan || plan.projectId !== projectId) return null;
  return plan;
}

export async function getRawWorkflow(workflowId) {
  const res = await jira(route`/rest/api/3/workflows`, { method: 'POST', body: { workflowIds: [String(workflowId)] } });
  const wf = res?.workflows?.[0];
  if (!wf) throw new Error('Workflow not found');
  return { wf, statuses: res.statuses || [] };
}

function pickWorkflow(bundle, { workflowId, workflowName }) {
  const wfs = bundle.workflows;
  if (workflowId) return wfs.find((w) => String(w.id) === String(workflowId));
  if (workflowName) {
    const n = String(workflowName).toLowerCase();
    return wfs.find((w) => w.name.toLowerCase() === n) || wfs.find((w) => w.name.toLowerCase().includes(n));
  }
  return wfs.length === 1 ? wfs[0] : null;
}

/** Project plans work on the project bundle, site-wide (bulk) plans on the affected workflows only. */
export async function loadContextBundle(project, workflowIds) {
  return project.id === SITE.id ? getWorkflowBundle(workflowIds) : getProjectBundle(project.id);
}

export const SITE = { id: 'site', key: 'SITE' };

/**
 * Jira's validation messages often don't say what they are about ("This status cannot be reached from the start
 * of the workflow."). Prefix them with the status or transition named in elementReference.
 */
export function jiraValidationMessage(e, payload) {
  const ref = e?.elementReference || {};
  const msg = String(e?.message || '');
  const status = ref.statusReference != null && (payload?.statuses || []).find((s) => String(s.statusReference) === String(ref.statusReference));
  const transition = ref.transitionId != null && (payload?.workflows?.[0]?.transitions || []).find((t) => String(t.id) === String(ref.transitionId));
  const where = transition?.name ? `"${transition.name}"` : status?.name ? `"${status.name}"` : '';
  return `${where && !msg.includes(where) ? `${where}: ` : ''}${msg}${ref.ruleId ? ` (${ref.ruleId})` : ''}`;
}

async function validateWithJira(raw, dr, bundle) {
  try {
    const migrations = dr.statusMappings.length ? dr.statusMappings : removedStatusMigrations(raw, dr.workflow);
    const psm = await projectStatusMappings(String(raw.id), migrations);
    const payload = buildUpdatePayload(dr.workflow, { siteStatuses: bundle.statuses, newStatuses: dr.newStatuses, statusMappings: migrations, projectStatusMappings: psm });
    const res = await jira(route`/rest/api/3/workflows/update/validation`, { method: 'POST', body: { payload, validationOptions: { levels: ['ERROR', 'WARNING'] } } });
    const errors = hintForMappingErrors((res?.errors || []).filter((e) => e.level === 'ERROR').map((e) => jiraValidationMessage(e, payload)), psm);
    const warnings = (res?.errors || []).filter((e) => e.level !== 'ERROR').map((e) => jiraValidationMessage(e, payload));
    return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], at: new Date().toISOString() };
  } catch (e) {
    return { ok: null, errors: [], warnings: [], unavailable: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * Create a change plan (no change in Jira yet).
 */
// Group names / IDs an operation list mentions (restrictTransition groups, replace/remove group references)
export function groupsInOps(ops) {
  const ids = [];
  const names = [];
  const add = (v) => {
    for (const x of (Array.isArray(v) ? v : String(v ?? '').split(',')).map((y) => String(y ?? '').trim()).filter(Boolean)) (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(x) ? ids : names).push(x.slice(0, 255));
  };
  for (const raw of Array.isArray(ops) ? ops : []) {
    if (!raw || typeof raw !== 'object') continue;
    const op = normalizeOp(raw);
    if (op.groups) add(op.groups);
    if (String(op.refType).toLowerCase() === 'group') { add(op.ref); add(op.with); }
  }
  return { ids: ids.slice(0, 200), names: names.slice(0, 200) };
}

export async function createPlan({ project, workflowId, workflowName, ops, instructions, explanation, explanationLang, source, user, bundle, lang, replaces }) {
  bundle ||= await getProjectBundle(project.id);
  const raw = pickWorkflow(bundle, { workflowId, workflowName });
  if (!raw) throw new Error(`Workflow not found. Available: ${bundle.workflows.map((w) => w.name).join(', ')}`);
  if (!Array.isArray(ops)) throw new Error('Operations must be a list');
  if (ops.length > MAX_OPS) throw new Error(`Too many operations (${ops.length}, max. ${MAX_OPS}) – split the change into several plans`);
  await ensureGroups(bundle.ref, groupsInOps(ops), bundle.warnings || []);
  const dr = dryRun(bundle, raw.id, ops, { lang });
  const usage = await getWorkflowProjects([String(raw.id)], { visibleToUser: project.id !== SITE.id }).catch(() => ({ usage: {} }));
  // Ask Jira itself already while planning (read-only validation endpoint), so rules Jira would
  // reject – e.g. resolution rules in team-managed spaces – show up before anyone clicks Apply.
  const validation = dr.results.some((r) => r.ok && !r.noop) ? await validateWithJira(raw, dr, bundle) : null;
  const plan = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    projectId: project.id,
    projectKey: project.key,
    workflowId: String(raw.id),
    workflowName: raw.name,
    scope: raw.scope?.type || 'GLOBAL',
    ownerProjectId: raw.scope?.project?.id ? String(raw.scope.project.id) : null,
    baseVersion: raw.version || null,
    title: String(instructions || explanation || '').slice(0, 140) || `${ops.length} operation(s)`,
    instructions: String(instructions || '').slice(0, 4000),
    explanation: String(explanation || '').slice(0, 4000),
    explanationLang: explanation && ['en', 'de'].includes(explanationLang) ? explanationLang : null,
    source: source || 'ui',
    lang: lang === 'de' ? 'de' : 'en',
    replaces: replaces || null,
    ops: cleanOps(ops),
    results: dr.results.map((r) => ({ op: cleanOps([r.op])[0], ok: r.ok, noop: r.noop || undefined, message: r.message })),
    changes: dr.changes.slice(0, 200),
    healthBefore: dr.healthBefore,
    healthAfter: dr.healthAfter,
    fixed: dr.fixed.slice(0, 60).map(slimFinding),
    introduced: dr.introduced.slice(0, 60).map(slimFinding),
    sharedProjects: usage.usage?.[String(raw.id)] || [],
    validation,
    status: !dr.results.some((r) => r.ok) || validation?.ok === false ? 'invalid' : dr.results.every((r) => !r.ok || r.noop) ? 'nochange' : 'planned',
    createdAt: new Date().toISOString(),
    createdBy: user?.accountId || null,
  };
  return savePlan(plan);
}

/**
 * Plan that fixes health findings automatically. `fingerprints` limits it to chosen findings (one finding, or
 * one kind of finding) – fingerprints, not finding IDs, because IDs are renumbered on every analysis.
 */
export async function createAutofixPlan({ project, workflowId, user, lang, fingerprints }) {
  const bundle = await getProjectBundle(project.id);
  const model = normalize(bundle);
  const only = Array.isArray(fingerprints) && fingerprints.length ? new Set(fingerprints.slice(0, 500).map(String)) : null;
  const candidates = only ? model.findings.filter((f) => only.has(findingFingerprint(f))) : model.findings;
  const wf = workflowId
    ? model.workflows.find((w) => w.id === String(workflowId))
    : [...model.workflows].sort((a, b) => candidates.filter((f) => f.wfId === b.id).length - candidates.filter((f) => f.wfId === a.id).length)[0];
  if (!wf) throw new Error('Workflow not found');
  const { ops, manual } = autofixOperations(model, candidates.filter((f) => f.wfId === wf.id), bundle.ref?.resolutions || []);
  if (!ops.length) {
    // An empty plan would only show up as "invalid" – say plainly that there is nothing to fix automatically
    const e = new Error(lang === 'de' ? 'Für diese Befunde gibt es keine automatische Korrektur.' : 'There is no automatic fix for these findings.');
    e.code = 'NOTHING_TO_FIX';
    throw e;
  }
  const n = new Set(ops.map((o) => o._f)).size;
  const plan = await createPlan({
    project,
    workflowId: wf.id,
    ops,
    instructions: lang === 'de' ? `Automatische Korrektur von ${n} Befund${n === 1 ? '' : 'en'} in „${wf.name}“` : `Auto-fix ${n} finding${n === 1 ? '' : 's'} in "${wf.name}"`,
    source: 'autofix',
    user,
    bundle,
    lang,
  });
  const fixedIds = new Set(plan.fixed.map((f) => f.id));
  plan.manual = manual.filter((f) => !fixedIds.has(f.id)).slice(0, 40).map(slimFinding);
  return savePlan(plan);
}

async function assertCanChange(plan) {
  // Site-wide (bulk) plans have no real project – only Jira admins may run them
  if (plan.scope === 'GLOBAL' || plan.projectId === SITE.id) {
    if (!(await isJiraAdmin())) throw new ForbiddenError(plan.scope === 'GLOBAL' ? 'FORBIDDEN_CHANGE_GLOBAL' : 'FORBIDDEN_SITE');
  } else if (!(await canAdministerProject(plan.ownerProjectId || plan.projectId))) throw new ForbiddenError('FORBIDDEN_PROJECT');
}

async function validateAndUpdate(payload, psm = null) {
  const validation = await jira(route`/rest/api/3/workflows/update/validation`, { method: 'POST', asUser: true, body: { payload, validationOptions: { levels: ['ERROR', 'WARNING'] } } });
  const errors = (validation?.errors || []).filter((e) => e.level === 'ERROR');
  const warnings = [...new Set((validation?.errors || []).filter((e) => e.level !== 'ERROR').map((e) => jiraValidationMessage(e, payload)))];
  if (errors.length) return { ok: false, errors: hintForMappingErrors(errors.map((e) => jiraValidationMessage(e, payload)), psm), warnings };
  const res = await jira(route`/rest/api/3/workflows/update`, { method: 'POST', asUser: true, body: payload });
  return { ok: true, warnings, taskId: res?.taskId || null, version: res?.workflows?.[0]?.version || null };
}

/**
 * Per project + issue type mappings for every project that uses the workflow. Jira requires an entry
 * for each pair with a migration for every removed status (verified live against Jira Cloud).
 */
async function projectStatusMappings(workflowId, migrations) {
  if (!migrations.length) return [];
  const { map, unreadable } = await workflowUsageMap(workflowId);
  const out = [];
  // Archived projects keep their usage but cannot be read; they are left out (see hintForMappingErrors)
  for (const [projectId, issueTypeIds] of map) for (const issueTypeId of issueTypeIds) out.push({ projectId, issueTypeId, statusMigrations: migrations });
  out.unreadable = unreadable;
  return out;
}

// Jira's raw message only lists project IDs – tell the admin what to do about projects the app cannot read
function hintForMappingErrors(errors, psm) {
  const unreadable = psm?.unreadable || [];
  if (!unreadable.length || !errors.some((e) => /projects are missing from the status mappings/i.test(e))) return errors;
  return [...errors, `Jira also expects mappings for project(s) ${unreadable.join(', ')}, which cannot be read (archived or deleted). Restore those projects or remove the workflow from them, then plan again.`];
}

async function saveBackup(planId, data) {
  const parts = chunkString(JSON.stringify(data));
  for (let i = 0; i < parts.length; i++) await kvs.set(`planbak-${planId}-${i}`, parts[i]);
  return parts.length;
}

async function loadBackup(planId, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += (await kvs.get(`planbak-${planId}-${i}`)) || '';
  return s ? JSON.parse(s) : null;
}

const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * Claims the plan for one apply. KVS has no compare-and-set, so we write a unique token and read it back:
 * of two parallel requests (double click, two admins) only the last writer proceeds.
 */
async function claimPlan(project, planId) {
  const plan = await getPlan(project.id, planId);
  if (!plan) throw new Error('Plan not found');
  const staleLock = plan.status === 'applying' && Date.now() - new Date(plan.lockAt || 0).getTime() > LOCK_STALE_MS;
  if (plan.status !== 'planned' && !staleLock) throw new Error(plan.status === 'applying' ? 'This plan is being applied right now' : `Plan is ${plan.status}`);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await savePlan({ ...plan, status: 'applying', lock: token, lockAt: new Date().toISOString() });
  const check = await getPlan(project.id, planId);
  if (check?.lock !== token) throw new Error('This plan is being applied right now');
  return { ...plan, lock: token };
}

export async function applyPlan({ project, planId, confirmShared, user }) {
  const plan0 = await getPlan(project.id, planId);
  if (!plan0) throw new Error('Plan not found');
  if (plan0.status !== 'planned' && plan0.status !== 'applying') throw new Error(`Plan is ${plan0.status}`);
  if (Date.now() - new Date(plan0.createdAt).getTime() > PLAN_TTL_MS) throw new Error('Plan expired – please create it again');
  await assertCanChange(plan0);
  if (plan0.sharedProjects.length > 1 && !confirmShared) {
    const named = plan0.sharedProjects.filter((p) => p.key).map((p) => p.key);
    const hidden = plan0.sharedProjects.length - named.length;
    const e = new Error(`SHARED_WORKFLOW: used by ${[...named, ...(hidden ? [`${hidden} other project(s)`] : [])].join(', ')}`);
    e.code = 'SHARED_CONFIRM';
    throw e;
  }
  const plan = await claimPlan(project, planId);
  try {
    return await applyClaimed({ project, plan, user });
  } catch (e) {
    // Release the lock so the plan can be retried (nothing was written, or Jira rejected it)
    const cur = await getPlan(project.id, planId);
    if (cur?.lock === plan.lock && cur.status === 'applying') await savePlan({ ...cur, status: 'planned', lock: null, lockAt: null, lastError: String(e?.message || e).slice(0, 300) });
    throw e;
  }
}

async function applyClaimed({ project, plan, user }) {
  // Re-apply on the latest version so concurrent edits are not overwritten
  const { wf: fresh, statuses } = await getRawWorkflow(plan.workflowId);
  const ctxBundle = await loadContextBundle(project, [plan.workflowId]);
  const bundleRef = await ensureGroups(ctxBundle.ref, groupsInOps(plan.ops), ctxBundle.warnings || []);
  const re = applyOperations(fresh, plan.ops, { statuses, ref: bundleRef, resolutions: bundleRef?.resolutions || [], lang: plan.lang });
  const failed = re.results.filter((r) => !r.ok);
  const okOps = re.results.filter((r) => r.ok && !r.noop);
  if (!okOps.length) throw new Error(`Nothing to apply: ${re.results.map((f) => f.message).join('; ')}`);

  // Safety net: snapshot + raw backup for rollback
  const model = normalize(ctxBundle);
  await store.saveSnapshot(project.id, makeSnapshot(model, { label: `Autopilot: before "${plan.title.slice(0, 60)}"`, by: user?.accountId ? null : 'Autopilot' }), user?.accountId || null);
  const backupChunks = await saveBackup(plan.id, { wf: fresh, statuses });

  const migrations = re.statusMappings.length ? re.statusMappings : removedStatusMigrations(fresh, re.workflow);
  const psm = await projectStatusMappings(plan.workflowId, migrations);
  const payload = buildUpdatePayload(re.workflow, { siteStatuses: statuses, newStatuses: re.newStatuses, statusMappings: migrations, projectStatusMappings: psm });
  const out = await validateAndUpdate(payload, psm);
  plan.applyResults = re.results.map((r) => ({ op: r.op, ok: r.ok, noop: r.noop || undefined, message: r.message }));
  plan.backupChunks = backupChunks;
  plan.lock = null;
  plan.lockAt = null;
  if (!out.ok) {
    plan.status = 'failed';
    plan.errors = out.errors;
  } else {
    plan.status = 'applied';
    // Version Jira gave the workflow with our change; a later rollback compares against it
    plan.appliedVersion = out.version || null;
    // What the workflow looks like right after our change – a later rollback compares against it
    plan.appliedSignature = await getRawWorkflow(plan.workflowId).then(({ wf }) => workflowSignature(wf)).catch(() => null);
    plan.appliedAt = new Date().toISOString();
    plan.appliedById = user?.accountId || null;
    plan.taskId = out.taskId;
    plan.warnings = out.warnings;
  }
  await savePlan(plan);
  return plan;
}

export async function rollbackPlan({ project, planId, user, confirmOverwrite }) {
  const plan = await getPlan(project.id, planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== 'applied') throw new Error('Only applied plans can be rolled back');
  await assertCanChange(plan);
  const backup = await loadBackup(plan.id, plan.backupChunks || 0);
  if (!backup) throw new Error('Backup not found');
  const { wf: current, statuses } = await getRawWorkflow(plan.workflowId);
  if (!confirmOverwrite && plan.appliedSignature && workflowSignature(current) !== plan.appliedSignature) {
    const e = new Error('The workflow was changed after this plan was applied. A rollback would also undo those later changes.');
    e.code = 'ROLLBACK_CONFIRM';
    throw e;
  }
  const allStatuses = [...statuses, ...backup.statuses.filter((s) => !statuses.some((x) => x.statusReference === s.statusReference))];
  const migrations = removedStatusMigrations(current, backup.wf);
  const psm = await projectStatusMappings(plan.workflowId, migrations);
  const payload = buildUpdatePayload({ ...backup.wf, version: current.version }, { siteStatuses: allStatuses, statusMappings: migrations, projectStatusMappings: psm });
  const out = await validateAndUpdate(payload, psm);
  if (!out.ok) {
    plan.rollbackErrors = out.errors;
    await savePlan(plan);
    throw new Error(`Rollback rejected by Jira: ${out.errors.join('; ')}`);
  }
  plan.status = 'rolledback';
  plan.rollbackErrors = undefined; // errors of earlier failed attempts are no longer relevant
  plan.rolledBackAt = new Date().toISOString();
  plan.rolledBackById = user?.accountId || null;
  await savePlan(plan);
  return plan;
}

/**
 * Plan the same operations again on the workflow as it is now – for plans that expired or whose workflow was
 * changed since. The old plan is discarded only once the new one exists.
 */
export async function replanPlan({ project, planId, user, lang }) {
  const old = await getPlan(project.id, planId);
  if (!old) throw new Error('Plan not found');
  if (!['planned', 'invalid', 'nochange', 'failed'].includes(old.status)) throw new Error(`Plan is ${old.status}`);
  const plan = await createPlan({
    project,
    workflowId: old.workflowId,
    ops: old.ops,
    instructions: old.instructions || old.title,
    explanation: old.explanation,
    explanationLang: old.explanationLang,
    source: old.source,
    user,
    lang: lang || old.lang,
    replaces: old.id,
    bundle: old.projectId === SITE.id ? await loadContextBundle(project, [old.workflowId]) : undefined,
  });
  if (old.manual) await savePlan({ ...plan, manual: old.manual });
  if (old.status === 'planned' || old.status === 'invalid' || old.status === 'nochange') await savePlan({ ...old, status: 'discarded' });
  return old.manual ? { ...plan, manual: old.manual } : plan;
}

export async function discardPlan({ project, planId }) {
  const plan = await getPlan(project.id, planId);
  if (!plan) return false;
  if (plan.status === 'planned' || plan.status === 'invalid') {
    plan.status = 'discarded';
    await savePlan(plan);
  }
  return true;
}
