import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import { getProjectBundle, searchWorkflowsPage, getWorkflowProjects, getReferenceData, jira, getStatusLoad, getCreatableIssueTypes, createIssue, getWorkflowBundle, projectWorkflowIds } from './lib/jira.js';
import { monitorProject, monitorRun } from './monitor.js';
import * as plans from './lib/plans.js';
import * as bulk from './lib/bulk.js';
import { aiPlan, aiAsk } from './lib/ai.js';
import { modelContext } from './shared/context.js';
import { normalizeLang } from './shared/i18n.js';
import { assertProjectAdmin, assertJiraAdmin, ForbiddenError, canAdministerProject, isJiraAdmin, userCapabilities } from './lib/auth.js';
import * as store from './lib/store.js';
import { normalize } from './shared/engine.js';
import { makeSnapshot } from './shared/snapshot.js';

export { actOverview, actFindUsages, actHealth, actExplain, actStatusLoad, actAccess, actCompare, actRemediate, actPlanChange, actApplyChange, actRollbackChange, actAutofix, actListPlans } from './rovo.js';

const ADMIN_MODULE = 'workflow-analyzer-admin';

const resolver = new Resolver();

function ctxProject(context) {
  const p = context?.extension?.project;
  return p ? { id: String(p.id), key: p.key } : null;
}

const isAdminModule = (context) => String(context?.moduleKey || '').endsWith(ADMIN_MODULE);

// Wrap resolver functions: map errors to a serialisable shape the UI understands.
function define(name, fn) {
  resolver.define(name, async (req) => {
    try {
      return { ok: true, data: await fn(req.payload || {}, req.context || {}) };
    } catch (e) {
      if (e instanceof ForbiddenError) return { ok: false, error: e.code };
      if (e?.code === 'SHARED_CONFIRM' || e?.code === 'ROLLBACK_CONFIRM' || e?.code === 'AI_UNAVAILABLE' || e?.code === 'NOTHING_TO_FIX') return { ok: false, error: e.code, message: e.message };
      console.error(`[${name}]`, e?.status || '', e?.message || e);
      return { ok: false, error: 'FAILED', status: e?.status || null, message: String(e?.message || e).slice(0, 500) };
    }
  });
}

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
  const caps = await userCapabilities(admin ? null : project?.id);
  return {
    mode: admin ? 'site' : 'project',
    project,
    user,
    prefs,
    allowed: admin ? caps.jiraAdmin : caps.projectAdmin,
    isJiraAdmin: caps.jiraAdmin,
    caps: { ...caps, bulk: admin && caps.jiraAdmin },
  };
});

define('setPrefs', async (payload, context) => store.setPrefs(context.accountId, payload));

// ---------------------------------------------------------------- project analysis

define('getProjectData', async (_p, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const bundle = await getProjectBundle(project.id);
  const ids = bundle.workflows.map((w) => String(w.id));
  await store.setProjectWorkflows(project.id, ids).catch(() => {});
  const notes = await store.getNotes(ids);
  return { bundle, notes };
});

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
  return store.saveNote(String(workflowId), String(transitionId), text, await me());
});

define('getNotes', async ({ workflowIds }, context) => {
  const scope = await noteScope(context);
  const ids = (Array.isArray(workflowIds) ? workflowIds : []).map(String).filter(store.isSafeId).slice(0, 500);
  return store.getNotes(scope ? ids.filter((id) => scope.has(id)) : ids);
});

// ---------------------------------------------------------------- snapshots (project page only)

define('listSnapshots', async (_p, context) => {
  const project = await requireAccess(context);
  return project ? store.listSnapshots(project.id) : [];
});

define('saveSnapshot', async ({ label }, context) => {
  const project = await requireAccess(context);
  if (!project) throw new ForbiddenError('FORBIDDEN_PROJECT');
  const model = normalize(await getProjectBundle(project.id));
  const user = await me();
  const snap = makeSnapshot(model, { label: String(label || '').slice(0, 120), by: user?.displayName || context.accountId });
  return store.saveSnapshot(project.id, snap);
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
  const user = await me();
  const created = [];
  const skipped = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 25)) {
    if (!it?.fingerprint || !it?.summary) continue;
    if (existing[it.fingerprint]) { skipped.push({ fingerprint: it.fingerprint, key: existing[it.fingerprint].key }); continue; }
    const key = await createIssue({ projectKey: target, issueTypeId, summary: String(it.summary).slice(0, 250), description: it.description, labels: ['workflow-health', 'superport-wfa'] });
    created.push({ fingerprint: it.fingerprint, key, by: user?.displayName });
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
  const user = await me();
  await store.setMonitoring(project, !!enabled, user?.displayName);
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
  const bundle = await getProjectBundle(project.id);
  const ctx = modelContext(normalize(bundle), { workflowId, lang: normalizeLang(lang), ref: bundle.ref });
  return aiAsk({ question, history, context: ctx, lang: normalizeLang(lang) });
});

define('aiPlan', async ({ instructions, workflowId, lang }, context) => {
  const project = await projectOnly(context);
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

define('listPlans', async (_p, context) => plans.listPlans((await projectOnly(context)).id));
define('getPlan', async ({ id }, context) => plans.getPlan((await projectOnly(context)).id, String(id)));
define('applyPlan', async ({ id, confirmShared }, context) => plans.applyPlan({ project: await projectOnly(context), planId: String(id), confirmShared: !!confirmShared, user: await me() }));
define('rollbackPlan', async ({ id, confirmOverwrite }, context) => plans.rollbackPlan({ project: await projectOnly(context), planId: String(id), confirmOverwrite: confirmOverwrite === true, user: await me() }));
define('discardPlan', async ({ id }, context) => plans.discardPlan({ project: await projectOnly(context), planId: String(id) }));

// ---------------------------------------------------------------- Bulk Autopilot (site-wide, Jira admins)

define('siteBulkList', async (_p, context) => {
  await requireSiteAccess(context);
  return bulk.listBulks();
});
define('siteBulkGet', async ({ id }, context) => {
  await requireSiteAccess(context);
  return bulk.getBulk(String(id));
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
  const wb = await getWorkflowBundle([String(workflowId)]);
  const ctx = modelContext(normalize(wb), { lang: normalizeLang(lang), ref: wb.ref });
  const bulkHint = '\nThis change will be applied to MANY workflows. Prefer transition selectors (@all, @done, @global, @to:<status>, @from:<status>, @name:<text>) and refType/ref operations over names that only exist in this example workflow.';
  return aiPlan({ instructions: `${instructions}${bulkHint}`, context: ctx, lang: normalizeLang(lang) });
});

export const monitor = async () => {
  await monitorRun();
};

export const handler = resolver.getDefinitions();
