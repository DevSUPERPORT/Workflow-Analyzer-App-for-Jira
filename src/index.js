/**
 * Backend entry point: defines every Custom UI resolver (bootstrap, project data, notes, snapshots, plans, bulk
 * changes, site scan, issue resolutions), exports the gated Rovo action handlers and the scheduled monitor.
 * Every resolver passes the SUPERPORT kill switch first (explicit READS allow-list, everything else is a write),
 * then checks the caller's role on the server. AI entry points (aiAsk, aiPlan, siteBulkAi, every Rovo action) also
 * pass SUPERPORT's AI budget (AI_BUDGET, set through App Status: stop and monthly limits) and the per-site AI
 * switch, which is off until a Jira admin turns it on (getAiSettings / setAiSettings). Paid via Atlassian: on a
 * site without an active Marketplace licence every resolver and Rovo action is refused (lib/license.js).
 *
 * @file        src/index.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-23
 */

import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import { getProjectBundle, searchWorkflowsPage, getWorkflowProjects, getReferenceData, jira, getStatusLoad, getCreatableIssueTypes, createIssue, getWorkflowBundle, projectWorkflowIds } from './lib/jira.js';
import { monitorProject, monitorRun } from './monitor.js';
import * as plans from './lib/plans.js';
import * as bulk from './lib/bulk.js';
import { aiPlan, aiAsk, requireAiEnabled, isAiError, aiUsage, aiCaps } from './lib/ai.js';
import { modelContext } from './shared/context.js';
import { normalizeLang, t as tr } from './shared/i18n.js';
import { assertProjectAdmin, assertJiraAdmin, ForbiddenError, canAdministerProject, isJiraAdmin, userCapabilities } from './lib/auth.js';
import * as store from './lib/store.js';
import * as issues from './lib/issues.js';
import { normalize, clearingSelfTransitions } from './shared/engine.js';
import { makeSnapshot } from './shared/snapshot.js';
import * as rovo from './rovo.js';
import { maintenanceMode, requireAvailable, STATUS_PAGE_URL, UnavailableError } from './lib/maintenance.js';
import { requireLicense, isLicenseInactive, LicenseError } from './lib/license.js';
import { withNames } from './lib/names.js';
import { reportPersonalData } from './lib/privacy.js';

// ---------------------------------------------------------------- Rovo actions (kill switch first)

// Every Rovo action passes the kill switch before anything else (see lib/maintenance.js). Actions that only read
// keep working in read-only mode; actions that create tasks, plans or change workflows are refused.
// The Rovo agent is an AI feature: while the site's AI switch is off (the default) every action answers with the
// "AI features are turned off" text, while SUPERPORT has stopped the AI (AI_BUDGET) with the "turned off by the app
// vendor" text, and a used-up monthly quota is answered the same way.
function rovoAction(kind, fn) {
  return async (payload, context) => {
    try {
      requireAvailable(kind);
      requireLicense(context, payload?.language);
      await requireAiEnabled(payload?.language);
      return await fn(payload, context);
    } catch (e) {
      if (e instanceof UnavailableError || e instanceof LicenseError) return { error: e.message };
      if (isAiError(e)) return { error: e.code === 'AI_DISABLED' ? `${e.message} ${tr(normalizeLang(payload?.language), 'ai.offRovo')}` : e.message };
      throw e;
    }
  };
}

export const actOverview = rovoAction('read', rovo.actOverview);
export const actFindUsages = rovoAction('read', rovo.actFindUsages);
export const actHealth = rovoAction('read', rovo.actHealth);
export const actExplain = rovoAction('read', rovo.actExplain);
export const actStatusLoad = rovoAction('read', rovo.actStatusLoad);
export const actAccess = rovoAction('read', rovo.actAccess);
export const actCompare = rovoAction('read', rovo.actCompare);
export const actResolutions = rovoAction('read', rovo.actResolutions);
export const actListPlans = rovoAction('read', rovo.actListPlans);
export const actRemediate = rovoAction('write', rovo.actRemediate);
export const actPlanChange = rovoAction('write', rovo.actPlanChange);
export const actApplyChange = rovoAction('write', rovo.actApplyChange);
export const actRollbackChange = rovoAction('write', rovo.actRollbackChange);
export const actAutofix = rovoAction('write', rovo.actAutofix);

const ADMIN_MODULE = 'workflow-analyzer-admin';

const resolver = new Resolver();

function ctxProject(context) {
  const p = context?.extension?.project;
  return p ? { id: String(p.id), key: p.key } : null;
}

const isAdminModule = (context) => String(context?.moduleKey || '').endsWith(ADMIN_MODULE);

// Resolvers that only read. Everything else counts as a write: a new resolver is blocked in read-only mode
// unless it is listed here on purpose. (Plans, notes, snapshots, visits and preferences are writes too, because
// they change the app's storage.)
const READS = new Set([
  'bootstrap', 'getProjectData', 'getNotes', 'listSnapshots', 'getSnapshot',
  'siteScanPage', 'siteRefs', 'siteProjects', 'getStatusLoad', 'getIssueTypes', 'getRemediation', 'getMonitoring',
  'aiAsk', 'listPlans', 'getPlan', 'siteBulkList', 'siteBulkGet',
  'resolutionAudit', 'resolutionIssues', 'resolutionRuns', 'getAiSettings',
]);

// Map errors to a serialisable shape the UI understands.
function wrap(name, fn) {
  return async (req) => {
    try {
      return { ok: true, data: await fn(req.payload || {}, req.context || {}) };
    } catch (e) {
      if (e instanceof UnavailableError) return { ok: false, error: e.code, mode: e.mode, message: e.message };
      if (e instanceof ForbiddenError) return { ok: false, error: e.code };
      if (e instanceof LicenseError) return { ok: false, error: e.code, message: e.message };
      if (e?.code === 'SHARED_CONFIRM' || e?.code === 'ROLLBACK_CONFIRM' || e?.code === 'AI_UNAVAILABLE' || e?.code === 'NOTHING_TO_FIX' || isAiError(e)) return { ok: false, error: e.code, message: e.message };
      console.error(`[${name}]`, e?.status || '', e?.message || e);
      return { ok: false, error: 'FAILED', status: e?.status || null, message: String(e?.message || e).slice(0, 500) };
    }
  };
}

/**
 * Every resolver passes the kill switch first (see lib/maintenance.js), then the Marketplace licence
 * (lib/license.js), before any permission check or Jira call.
 */
function define(name, fn) {
  resolver.define(name, wrap(name, async (payload, context) => {
    requireAvailable(READS.has(name) ? 'read' : 'write');
    requireLicense(context, payload?.lang);
    return fn(payload, context);
  }));
}

/** The UI asks first, so it can show "temporarily unavailable" or "read-only" before loading anything. */
resolver.define('availability', wrap('availability', async (_p, context) => {
  if (!context?.accountId) throw new ForbiddenError('FORBIDDEN');
  return { mode: maintenanceMode(), statusUrl: STATUS_PAGE_URL, licensed: !isLicenseInactive(context.license) };
}));

async function me() {
  try {
    const u = await jira(route`/rest/api/3/myself`, { asUser: true });
    return { accountId: u.accountId, displayName: u.displayName, locale: u.locale };
  } catch {
    return null;
  }
}

// Project page: project from context; admin page: no project.
async function requireAccess(context) {
  if (isAdminModule(context)) {
    await assertJiraAdmin();
    return null;
  }
  const project = ctxProject(context);
  await assertProjectAdmin(project?.id);
  return project;
}

// ---------------------------------------------------------------- bootstrap & prefs

define('bootstrap', async (_p, context) => {
  const [prefs, user] = await Promise.all([store.getPrefs(context.accountId), me()]);
  const project = ctxProject(context);
  const admin = isAdminModule(context);
  const [caps, ai, budget] = await Promise.all([userCapabilities(admin ? null : project?.id), store.getAiSettings(), aiCaps()]);
  return {
    mode: admin ? 'site' : 'project',
    project,
    user,
    prefs,
    allowed: admin ? caps.jiraAdmin : caps.projectAdmin,
    isJiraAdmin: caps.jiraAdmin,
    caps: { ...caps, bulk: admin && caps.jiraAdmin },
    // only whether AI is on (site switch and not stopped by SUPERPORT); who changed it and the usage are for Jira
    // admins (getAiSettings)
    ai: { enabled: ai.aiEnabled && !budget.stop, stopped: budget.stop },
  };
});

// ---------------------------------------------------------------- AI switch (per site, Jira admins)

// enabled is the site's own setting, kept while SUPERPORT has the AI stopped; limits come from AI_BUDGET
async function aiSettingsView() {
  const [s, caps] = await Promise.all([store.getAiSettings(), aiCaps()]);
  const view = { enabled: s.aiEnabled, stopped: caps.stop, updatedAt: s.updatedAt, updatedBy: s.updatedBy, usage: await aiUsage(undefined, caps) };
  await withNames(view, [['updatedBy', 'updatedByName']]);
  delete view.updatedBy;
  return view;
}

define('getAiSettings', async () => {
  await assertJiraAdmin();
  return aiSettingsView();
});

// Only users with the Jira global permission "Administer Jira", checked live against Jira for every change
define('setAiSettings', async ({ enabled }, context) => {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  await assertJiraAdmin();
  const user = await me();
  await store.setAiEnabled(enabled, { accountId: context.accountId || user?.accountId, displayName: user?.displayName });
  console.log(`[ai-settings] AI features turned ${enabled ? 'on' : 'off'} by ${context.accountId || 'unknown'}`);
  return aiSettingsView();
});

define('setPrefs', async (payload, context) => store.setPrefs(context.accountId, payload));

// ---------------------------------------------------------------- project analysis

define('getProjectData', async (_p, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const bundle = await getProjectBundle(project.id);
  const ids = bundle.workflows.map((w) => String(w.id));
  await store.setProjectWorkflows(project.id, ids).catch(() => {});
  const notes = await notesWithNames(await store.getNotes(ids));
  return { bundle, notes };
});

/** Notes carry the author's account ID; the name is looked up for display. */
async function notesWithNames(notes) {
  await withNames(Object.values(notes).flatMap((byTransition) => Object.values(byTransition || {})), [['by', 'byName']]);
  return notes;
}

/**
 * Workflow IDs the caller may read/write notes for: all (site page, Jira admins) or only the workflows of the
 * project the page is opened in – never another project's workflows, whatever the payload says.
 */
async function noteScope(context) {
  const project = await requireAccess(context);
  if (!project) return null; // site page: requireAccess already demanded Jira admin
  const cached = await store.getProjectWorkflows(project.id);
  const fresh = cached && Date.now() - new Date(cached.at).getTime() < 6 * 3600 * 1000;
  const ids = fresh ? cached.ids : await projectWorkflowIds(project.id);
  if (!fresh) await store.setProjectWorkflows(project.id, ids).catch(() => {});
  return new Set(ids);
}

define('saveNote', async ({ workflowId, transitionId, text }, context) => {
  const plain = (v) => typeof v === 'string' || typeof v === 'number';
  if (!plain(workflowId) || !plain(transitionId) || !workflowId || !transitionId) throw new Error('workflowId and transitionId are required');
  const scope = await noteScope(context);
  if (scope && !scope.has(String(workflowId))) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const note = await store.saveNote(String(workflowId), String(transitionId), text, { accountId: context.accountId });
  return note ? withNames(note, [['by', 'byName']]) : note;
});

define('getNotes', async ({ workflowIds }, context) => {
  const scope = await noteScope(context);
  const ids = (Array.isArray(workflowIds) ? workflowIds : []).map(String).filter(store.isSafeId).slice(0, 500);
  return notesWithNames(await store.getNotes(scope ? ids.filter((id) => scope.has(id)) : ids));
});

// ---------------------------------------------------------------- snapshots (project page only)

define('listSnapshots', async (_p, context) => {
  const project = await requireAccess(context);
  if (!project) return [];
  return snapshotsWithNames(await store.listSnapshots(project.id));
});

/** `by` is a system label for automatic snapshots, else the name of `byId` (looked up). */
async function snapshotsWithNames(list) {
  const people = list.filter((s) => s.byId);
  await withNames(people, [['byId', 'byName']]);
  for (const s of people) { s.by = s.byName; delete s.byName; }
  return list;
}

define('saveSnapshot', async ({ label }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const model = normalize(await getProjectBundle(project.id));
  const snap = makeSnapshot(model, { label: String(label || '').slice(0, 120), by: null });
  const entry = await store.saveSnapshot(project.id, snap, context.accountId || null);
  return (await snapshotsWithNames([entry]))[0];
});

define('getSnapshot', async ({ id }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  return store.getSnapshot(project.id, String(id));
});

define('deleteSnapshot', async ({ id }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  return store.deleteSnapshot(project.id, String(id));
});

// ---------------------------------------------------------------- site-wide scan (admin page)

async function requireSiteAccess(context) {
  if (!isAdminModule(context)) throw new ForbiddenError('FORBIDDEN_SITE');
  await assertJiraAdmin();
}

define('siteScanPage', async ({ startAt = 0 }, context) => {
  await requireSiteAccess(context);
  return searchWorkflowsPage(Math.max(0, Number(startAt) || 0), 20);
});

define('siteRefs', async ({ ids, firstWorkflowId }, context) => {
  await requireSiteAccess(context);
  const warnings = [];
  const clamp = (a) => (Array.isArray(a) ? a.map(String).slice(0, 3000) : []);
  const ref = await getReferenceData({ group: clamp(ids?.group), user: clamp(ids?.user), screen: clamp(ids?.screen) }, warnings, { firstWorkflowId });
  return { ref, warnings };
});

define('siteProjects', async ({ workflowIds }, context) => {
  await requireSiteAccess(context);
  return getWorkflowProjects((workflowIds || []).map(String).slice(0, 40));
});

// ---------------------------------------------------------------- phase 2: live load, remediation, monitoring

define('getStatusLoad', async ({ statusIds, staleDays }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  return getStatusLoad(project.key, Array.isArray(statusIds) ? statusIds : [], staleDays);
});

define('getIssueTypes', async ({ projectKey }, context) => {
  const project = await requireAccess(context);
  return getCreatableIssueTypes(String(projectKey || project?.key || '').toUpperCase());
});

define('getRemediation', async (_p, context) => {
  const project = await requireAccess(context);
  return project ? store.getRemediation(project.id) : {};
});

define('createRemediation', async ({ items, issueTypeId, projectKey }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const target = String(projectKey || project.key).toUpperCase();
  const existing = await store.getRemediation(project.id);
  const created = [];
  const skipped = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 25)) {
    if (!it?.fingerprint || !it?.summary) continue;
    if (existing[it.fingerprint]) { skipped.push({ fingerprint: it.fingerprint, key: existing[it.fingerprint].key }); continue; }
    const key = await createIssue({ projectKey: target, issueTypeId, summary: String(it.summary).slice(0, 250), description: it.description, labels: ['workflow-health', 'superport-wfa'] });
    created.push({ fingerprint: it.fingerprint, key, byId: context.accountId || null });
  }
  if (created.length) await store.addRemediation(project.id, created);
  return { created, skipped };
});

define('getMonitoring', async (_p, context) => {
  const project = await requireAccess(context);
  if (!project) return { enabled: false };
  const list = await store.getMonitoredProjects();
  return { enabled: list.some((p) => p.id === project.id), state: await store.getMonitorState(project.id) };
});

define('setMonitoring', async ({ enabled }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  await store.setMonitoring(project, !!enabled, context.accountId || null);
  const state = enabled ? await monitorProject(project) : await store.getMonitorState(project.id);
  return { enabled: !!enabled, state };
});

// `findings`: compact keys of the current findings. The previous visit's keys come back so the UI can show what is
// new and what was resolved since then (per user and project).
define('touchVisit', async ({ findings }, context) => {
  const project = await requireAccess(context);
  if (!project) return null;
  const keys = Array.isArray(findings) ? findings.filter((k) => typeof k === 'string' && /^[a-z0-9]{1,16}$/.test(k)).slice(0, 3000) : null;
  const [lastSeen, state, previous] = await Promise.all([store.touchLastSeen(context.accountId, project.id), store.getMonitorState(project.id), keys ? store.swapSeenFindings(context.accountId, project.id, keys) : null]);
  return { lastSeen, state, previous };
});

// ---------------------------------------------------------------- Autopilot & AI Copilot

async function projectOnly(context) {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  return project;
}

define('aiAsk', async ({ question, history, workflowId, lang }, context) => {
  const project = await projectOnly(context);
  await requireAiEnabled(lang);
  const bundle = await getProjectBundle(project.id);
  const ctx = modelContext(normalize(bundle), { workflowId, lang: normalizeLang(lang), ref: bundle.ref });
  return aiAsk({ question, history, context: ctx, lang: normalizeLang(lang) });
});

define('aiPlan', async ({ instructions, workflowId, lang }, context) => {
  const project = await projectOnly(context);
  await requireAiEnabled(lang);
  if (!String(instructions || '').trim()) throw new Error('instructions are required');
  const bundle = await getProjectBundle(project.id);
  const model = normalize(bundle);
  const target = workflowId || (model.workflows.length === 1 ? model.workflows[0].id : null);
  const ctx = modelContext(model, { workflowId: target, lang: normalizeLang(lang), ref: bundle.ref });
  const proposal = await aiPlan({ instructions, context: ctx, lang: normalizeLang(lang) });
  if (!proposal.operations.length) return { plan: null, explanation: proposal.explanation, model: proposal.model };
  const plan = await plans.createPlan({ project, workflowId: target, workflowName: proposal.workflow, ops: proposal.operations, instructions, explanation: proposal.explanation, explanationLang: normalizeLang(lang), source: 'copilot', user: await me(), bundle, lang: normalizeLang(lang) });
  return { plan, explanation: proposal.explanation, model: proposal.model };
});

define('createPlan', async ({ workflowId, ops, instructions, lang }, context) => {
  const project = await projectOnly(context);
  return plans.createPlan({ project, workflowId, ops: Array.isArray(ops) ? ops : [], instructions, source: 'ui', user: await me(), lang: normalizeLang(lang) });
});

define('autofixPlan', async ({ workflowId, lang, fingerprints }, context) => {
  const project = await projectOnly(context);
  return plans.createAutofixPlan({ project, workflowId, user: await me(), lang: normalizeLang(lang), fingerprints: Array.isArray(fingerprints) ? fingerprints : null });
});

define('replanPlan', async ({ id, lang }, context) => plans.replanPlan({ project: await projectOnly(context), planId: String(id), user: await me(), lang: normalizeLang(lang) }));

const AUTHOR = [['createdBy', 'createdByName']];
define('listPlans', async (_p, context) => withNames(await plans.listPlans((await projectOnly(context)).id), AUTHOR));
define('getPlan', async ({ id }, context) => withNames(await plans.getPlan((await projectOnly(context)).id, String(id)), AUTHOR));
define('applyPlan', async ({ id, confirmShared }, context) => plans.applyPlan({ project: await projectOnly(context), planId: String(id), confirmShared: !!confirmShared, user: await me() }));
define('rollbackPlan', async ({ id, confirmOverwrite }, context) => plans.rollbackPlan({ project: await projectOnly(context), planId: String(id), confirmOverwrite: confirmOverwrite === true, user: await me() }));
define('discardPlan', async ({ id }, context) => plans.discardPlan({ project: await projectOnly(context), planId: String(id) }));

// ---------------------------------------------------------------- Bulk Autopilot (site-wide, Jira admins)

define('siteBulkList', async (_p, context) => {
  await requireSiteAccess(context);
  return withNames(await bulk.listBulks(), AUTHOR);
});
define('siteBulkGet', async ({ id }, context) => {
  await requireSiteAccess(context);
  return withNames(await bulk.getBulk(String(id)), AUTHOR);
});
define('siteBulkCreate', async ({ workflowIds, ops, instructions, autofix, lang }, context) => {
  await requireSiteAccess(context);
  return bulk.createBulk({ workflowIds, ops, instructions, autofix, lang: normalizeLang(lang), user: await me() });
});
define('siteBulkPlanBatch', async ({ bulkId }, context) => {
  await requireSiteAccess(context);
  return bulk.planBatch({ bulkId: String(bulkId), limit: 5, user: await me() });
});
define('siteBulkApply', async ({ bulkId, workflowId, confirmShared }, context) => {
  await requireSiteAccess(context);
  return bulk.applyChild({ bulkId: String(bulkId), workflowId, confirmShared, user: await me() });
});
define('siteBulkRollback', async ({ bulkId, workflowId, confirmOverwrite }, context) => {
  await requireSiteAccess(context);
  return bulk.rollbackChild({ bulkId: String(bulkId), workflowId, confirmOverwrite: confirmOverwrite === true, user: await me() });
});
define('siteBulkAi', async ({ instructions, workflowId, lang }, context) => {
  await requireSiteAccess(context);
  await requireAiEnabled(lang);
  const wb = await getWorkflowBundle([String(workflowId)]);
  const ctx = modelContext(normalize(wb), { lang: normalizeLang(lang), ref: wb.ref });
  const bulkHint = '\nThis change will be applied to MANY workflows. Prefer transition selectors (@all, @done, @global, @to:<status>, @from:<status>, @name:<text>) and refType/ref operations over names that only exist in this example workflow.';
  return aiPlan({ instructions: `${instructions}${bulkHint}`, context: ctx, lang: normalizeLang(lang) });
});

// ---------------------------------------------------------------- issue resolutions (data repair)

// Project page: the project from the Forge context, never from the payload. Site page: Jira admins, whole site or
// one project key from the payload.
async function resolutionScope(context, payload) {
  const project = await requireAccess(context);
  if (project) return { projectKey: project.key, projectId: project.id, scope: `p-${project.id}`, admin: await isJiraAdmin() };
  const key = payload?.projectKey ? String(payload.projectKey).toUpperCase() : null;
  if (key && !issues.isProjectKey(key)) throw new Error('Invalid project key');
  return { projectKey: key, scope: 'site', admin: true };
}

define('resolutionAudit', async (payload, context) => {
  const { projectKey } = await resolutionScope(context, payload);
  return issues.resolutionAudit(projectKey);
});

define('resolutionIssues', async ({ kind, nextPageToken, ...payload }, context) => {
  const { projectKey } = await resolutionScope(context, payload);
  return issues.resolutionIssues(projectKey, String(kind), nextPageToken);
});

define('resolutionRepair', async ({ items, runId, kind, undoOf, ...payload }, context) => {
  const { projectKey, projectId, scope, admin } = await resolutionScope(context, payload);
  // Clearing needs the project's workflows: Jira Cloud only clears a resolution through a transition
  const clearsSome = Array.isArray(items) && items.some((i) => i && (i.to == null || i.to === ''));
  const clearing = clearsSome && scope !== 'site' ? clearingSelfTransitions(normalize(await getProjectBundle(projectId))) : null;
  const out = await issues.repairResolutions({ projectKey: scope === 'site' ? null : projectKey, items, admin, clearing });
  const run = await issues.recordRun(scope, { runId, kind, undoOf, byId: context.accountId || null, results: out.results }).catch(() => null);
  return { ...out, run: run ? { id: run.id, items: run.items.length } : null };
});

define('resolutionRuns', async (payload, context) => {
  const { scope } = await resolutionScope(context, payload);
  const runs = await issues.listRuns(scope);
  await withNames(runs, [['byId', 'by']]);
  return runs;
});

// Scheduled trigger. The daily monitor only exists to store snapshots, so it does nothing unless the app is fully
// on: "on" stops everything, "readonly" stops it too because every run writes (see monitorRun).
export const monitor = async () => {
  if (maintenanceMode() !== 'off') return;
  await monitorRun();
};

// Daily trigger for Atlassian's personal data reporting (lib/privacy.js; reports at most once a week). Not limited to
// licensed sites: stored account IDs must be reported either way. Skipped while the kill switch is on or read-only
// (it can write); the next day catches up.
export const privacy = async () => {
  if (maintenanceMode() !== 'off') return;
  await reportPersonalData().catch((e) => console.error('[privacy] personal data report failed:', e?.status || '', e?.statusText || e?.message || e));
};

export const handler = resolver.getDefinitions();
