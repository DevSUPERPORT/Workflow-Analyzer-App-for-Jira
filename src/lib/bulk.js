/**
 * Bulk Autopilot: one change set for many workflows (site-wide, Jira admins). The client drives the work in
 * small batches because of the Forge resolver time limit: create, plan batches, apply one by one, roll back per
 * workflow.
 *
 * @file        src/lib/bulk.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { kvs } from '@forge/kvs';
import * as plans from './plans.js';
import { getWorkflowBundle } from './jira.js';
import { normalize } from '../shared/engine.js';
import { autofixOperations } from '../shared/autopilot.js';
import { findingFingerprint } from '../shared/insights.js';

const MAX_TARGETS = 200;
const bulkKey = (id) => `bulk-${id}`;
const IDX = 'bulkidx';

async function save(bulk) {
  await kvs.set(bulkKey(bulk.id), bulk);
  const idx = (await kvs.get(IDX)) || [];
  const entry = { id: bulk.id, title: bulk.title, createdAt: bulk.createdAt, createdByName: bulk.createdByName, targets: bulk.children.length, status: bulk.status, counts: counts(bulk) };
  await kvs.set(IDX, [entry, ...idx.filter((e) => e.id !== bulk.id)].slice(0, 30));
  return bulk;
}

export function counts(bulk) {
  const c = { pending: 0, planned: 0, nochange: 0, invalid: 0, applied: 0, failed: 0, rolledback: 0, discarded: 0 };
  for (const ch of bulk.children) c[ch.status] = (c[ch.status] || 0) + 1;
  return c;
}

export async function listBulks() {
  return (await kvs.get(IDX)) || [];
}

export async function getBulk(id) {
  return kvs.get(bulkKey(String(id)));
}

/**
 * `autofix: { fingerprints }` instead of ops: every workflow gets its own auto-fix operations for the chosen findings
 * (auto-fix operations address transitions by each workflow's own IDs, so one shared op list would not fit).
 */
export async function createBulk({ workflowIds, ops, instructions, user, autofix, lang }) {
  const ids = [...new Set((Array.isArray(workflowIds) ? workflowIds : []).map(String))];
  if (!ids.length) throw new Error('Select at least one workflow');
  if (ids.length > MAX_TARGETS) throw new Error(`At most ${MAX_TARGETS} workflows per bulk change (selected: ${ids.length}). Split the change into several runs.`);
  const fingerprints = Array.isArray(autofix?.fingerprints) ? [...new Set(autofix.fingerprints.map(String))].slice(0, 4000) : null;
  if (fingerprints && !fingerprints.length) throw new Error('No findings selected');
  if (fingerprints) ops = [];
  else if (!Array.isArray(ops) || !ops.length) throw new Error('No operations');
  if (ops.length > 40) throw new Error(`Too many operations (${ops.length}, max. 40 per bulk change)`);
  const bulk = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: String(instructions || `${ops.length} operation(s)`).slice(0, 140),
    instructions: String(instructions || '').slice(0, 2000),
    ops,
    autofix: fingerprints ? { fingerprints } : undefined,
    lang: lang === 'de' ? 'de' : 'en',
    createdAt: new Date().toISOString(),
    createdBy: user?.accountId || null,
    createdByName: user?.displayName || null,
    status: 'planning',
    children: ids.map((workflowId) => ({ workflowId, workflowName: null, planId: null, status: 'pending' })),
  };
  return save(bulk);
}

/**
 * Loads the workflows of a batch in one request; if Jira rejects it (e.g. one workflow was deleted in the meantime),
 * loads them one by one so a single bad workflow cannot block the whole bulk change.
 */
async function loadBundleTolerant(ids) {
  try {
    return { bundle: await getWorkflowBundle(ids), failed: new Map() };
  } catch (e) {
    if (ids.length === 1) return { bundle: { workflows: [] }, failed: new Map([[ids[0], String(e?.message || e).slice(0, 300)]]) };
    const ok = [];
    const failed = new Map();
    for (const id of ids) {
      try {
        await getWorkflowBundle([id]);
        ok.push(id);
      } catch (err) {
        failed.set(id, String(err?.message || err).slice(0, 300));
      }
    }
    return { bundle: ok.length ? await getWorkflowBundle(ok) : { workflows: [] }, failed };
  }
}

/** Dry-run + Jira-validate up to `limit` pending workflows of the bulk. */
export async function planBatch({ bulkId, limit = 5, user }) {
  const bulk = await getBulk(bulkId);
  if (!bulk) throw new Error('Bulk change not found');
  const pending = bulk.children.filter((c) => c.status === 'pending').slice(0, Math.min(10, limit));
  if (pending.length) {
    const { bundle, failed } = await loadBundleTolerant(pending.map((c) => c.workflowId));
    const wanted = bulk.autofix ? new Set(bulk.autofix.fingerprints) : null;
    const model = wanted && bundle.workflows.length ? normalize(bundle) : null;
    for (const ch of pending) {
      const raw = bundle.workflows.find((w) => String(w.id) === ch.workflowId);
      if (!raw && failed.has(ch.workflowId)) {
        ch.status = 'invalid';
        ch.error = failed.get(ch.workflowId);
        continue;
      }
      if (!raw) {
        ch.status = 'invalid';
        ch.error = 'Workflow not found';
        continue;
      }
      let ops = bulk.ops;
      if (wanted) {
        ops = autofixOperations(model, model.findings.filter((f) => f.wfId === ch.workflowId && wanted.has(findingFingerprint(f))), bundle.ref?.resolutions || []).ops;
        if (!ops.length) {
          Object.assign(ch, { workflowName: raw.name, status: 'nochange', error: 'Nothing to fix automatically in this workflow (any more)' });
          continue;
        }
      }
      try {
        const plan = await plans.createPlan({ project: plans.SITE, workflowId: ch.workflowId, ops, instructions: `${bulk.title} – ${raw.name}`, source: 'bulk', user, bundle, lang: bulk.lang });
        Object.assign(ch, { workflowName: raw.name, planId: plan.id, status: plan.status, healthBefore: plan.healthBefore, healthAfter: plan.healthAfter, changes: plan.changes.length, shared: plan.sharedProjects.map((p) => p.key), validationOk: plan.validation?.ok ?? null, scope: plan.scope });
      } catch (e) {
        Object.assign(ch, { workflowName: raw.name, status: 'invalid', error: String(e?.message || e).slice(0, 300) });
      }
    }
  }
  if (!bulk.children.some((c) => c.status === 'pending')) bulk.status = 'ready';
  return save(bulk);
}

/** Apply one child plan (client loops with progress, can stop at any time). */
export async function applyChild({ bulkId, workflowId, user, confirmShared }) {
  const bulk = await getBulk(bulkId);
  if (!bulk) throw new Error('Bulk change not found');
  const ch = bulk.children.find((c) => c.workflowId === String(workflowId));
  if (!ch?.planId || ch.status !== 'planned') throw new Error(`Workflow is ${ch?.status || 'unknown'} – nothing to apply`);
  try {
    const plan = await plans.applyPlan({ project: plans.SITE, planId: ch.planId, confirmShared: !!confirmShared, user });
    ch.status = plan.status;
    ch.error = plan.errors?.join('; ') || undefined;
    ch.needsShared = undefined;
  } catch (e) {
    // The plan releases its lock when nothing was written – keep the child retryable in that case
    const plan = await plans.getPlan(plans.SITE.id, ch.planId).catch(() => null);
    ch.status = plan?.status === 'planned' ? 'planned' : 'failed';
    ch.needsShared = e?.code === 'SHARED_CONFIRM' || undefined;
    ch.error = String(e?.message || e).slice(0, 300);
  }
  bulk.status = bulk.children.some((c) => c.status === 'planned') ? 'applying' : 'done';
  await save(bulk);
  return ch;
}

export async function rollbackChild({ bulkId, workflowId, user, confirmOverwrite }) {
  const bulk = await getBulk(bulkId);
  if (!bulk) throw new Error('Bulk change not found');
  const ch = bulk.children.find((c) => c.workflowId === String(workflowId));
  if (!ch?.planId || ch.status !== 'applied') throw new Error('Only applied workflows can be rolled back');
  try {
    const plan = await plans.rollbackPlan({ project: plans.SITE, planId: ch.planId, user, confirmOverwrite });
    ch.status = plan.status;
    ch.error = undefined;
    ch.needsConfirm = undefined;
  } catch (e) {
    ch.error = String(e?.message || e).slice(0, 300);
    ch.needsConfirm = e?.code === 'ROLLBACK_CONFIRM' || undefined;
  }
  await save(bulk);
  return ch;
}
