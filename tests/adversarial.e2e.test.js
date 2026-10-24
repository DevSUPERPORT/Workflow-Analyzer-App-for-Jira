// Adversarial end-to-end tests: cross-project access, hostile payloads, races, injected faults and scale.
// Every test asserts on what Jira ends up containing, not only on what the app reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, G, scenario, ctxProject, ctxSite, call, ok, shape } from './support/harness.js';

// successful (non-injected) workflow writes that reached Jira
const writes = (j) => j.log.filter((l) => /^[AU] POST \/rest\/api\/3\/workflows\/update$/.test(l));
const renameOps = [{ op: 'renameTransition', transition: 'Start', newName: 'Begin' }];

test('cross-project access: a plan of another project can be neither read nor applied', async () => {
  const { j } = scenario();
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin = new Set(['100', '200']);
  const tmp = ctxProject('200', 'TMP');
  const foreign = await ok('createPlan', { workflowId: 'wf-3', ops: [{ op: 'renameTransition', transition: 'Done', newName: 'Fin' }] }, tmp);
  j.perms.projectAdmin = new Set(['100']);
  assert.equal((await call('getPlan', { id: foreign.id })).data, null);
  assert.equal((await call('applyPlan', { id: foreign.id })).ok, false);
  assert.equal((await call('applyPlan', { id: foreign.id }, tmp)).error, 'FORBIDDEN_PROJECT');
  // a workflow of another project cannot be targeted, and payload fields cannot override the context project
  assert.equal((await call('createPlan', { workflowId: 'wf-3', ops: renameOps })).ok, false);
  assert.equal((await call('createPlan', { workflowId: 'wf-3', projectId: '200', project: { id: '200' }, ops: renameOps })).ok, false);
  assert.equal(writes(j).length, 0);
});

test('a project admin who is not a Jira admin cannot change a global (company-managed) workflow', async () => {
  const { j } = scenario();
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin = new Set(['100']);
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  assert.equal((await call('applyPlan', { id: plan.id })).error, 'FORBIDDEN_CHANGE_GLOBAL');
  assert.equal(writes(j).length, 0);
});

test('double click: applying the same plan twice in parallel changes Jira exactly once', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'addStatus', name: 'Parked', category: 'TODO' }, { op: 'addTransition', name: 'Park', from: ['Open'], to: 'Parked' }] });
  const results = await Promise.all([call('applyPlan', { id: plan.id }), call('applyPlan', { id: plan.id })]);
  assert.equal(results.filter((r) => r.ok && r.data.status === 'applied').length, 1, JSON.stringify(results.map((r) => r.data?.status || r.message)));
  assert.equal(writes(j).length, 1);
  assert.equal(j.workflows.get('wf-1').transitions.filter((t) => t.name === 'Park').length, 1);
});

test('rollback never silently overwrites changes a colleague made after the apply', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  await ok('applyPlan', { id: plan.id });
  const wf = j.workflows.get('wf-1');
  wf.transitions.find((t) => t.name === 'Archive').name = 'Archive (colleague)';
  wf.version = { id: 'v-colleague', versionNumber: wf.version.versionNumber + 1 };
  const refused = await call('rollbackPlan', { id: plan.id });
  assert.equal(refused.error, 'ROLLBACK_CONFIRM', JSON.stringify(refused));
  assert.ok(j.workflows.get('wf-1').transitions.some((t) => t.name === 'Archive (colleague)'), 'colleague change kept');
  const forced = await ok('rollbackPlan', { id: plan.id, confirmOverwrite: true });
  assert.equal(forced.status, 'rolledback');
  assert.ok(j.workflows.get('wf-1').transitions.some((t) => t.name === 'Start'));
});

test('Jira failing during the update leaves the plan retryable and never marks it applied', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  j.faults.push({ match: /POST \/rest\/api\/3\/workflows\/update$/, status: 500, times: 1 });
  const failed = await call('applyPlan', { id: plan.id });
  assert.equal(failed.ok, false);
  assert.equal((await ok('getPlan', { id: plan.id })).status, 'planned', 'plan stays retryable');
  assert.equal(j.workflows.get('wf-1').version.versionNumber, 0);
  const retried = await ok('applyPlan', { id: plan.id });
  assert.equal(retried.status, 'applied');
});

test('no backup, no change: if storage fails the workflow is not touched', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  state.kvsFail = /^planbak-/;
  assert.equal((await call('applyPlan', { id: plan.id })).ok, false);
  assert.equal(writes(j).length, 0);
  state.kvsFail = null;
  assert.equal((await ok('getPlan', { id: plan.id })).status, 'planned');
});

test('permanent rate limiting ends with an error instead of hanging', async () => {
  const { j } = scenario();
  j.faults.push({ match: /./, status: 429, times: -1 });
  const t0 = Date.now();
  const res = await call('getProjectData');
  assert.equal(res.ok, false);
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});

test('workflow deleted between planning and applying gives a clear error', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  j.workflows.delete('wf-1');
  const res = await call('applyPlan', { id: plan.id });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/i);
});

test('expired and discarded plans cannot be applied', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  const key = [...state.kvs.keys()].find((k) => state.kvs.get(k)?.id === plan.id && state.kvs.get(k)?.ops);
  state.kvs.set(key, { ...state.kvs.get(key), createdAt: '2020-01-01T00:00:00Z' });
  assert.match((await call('applyPlan', { id: plan.id })).message, /expired/i);
  const p2 = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  await ok('discardPlan', { id: p2.id });
  assert.match((await call('applyPlan', { id: p2.id })).message, /discarded/);
  assert.equal(writes(j).length, 0);
});

test('hostile payloads are rejected cleanly: no crash, no Jira write, no prototype pollution', async () => {
  const { j } = scenario();
  const hostile = [
    null,
    { workflowId: { $ne: 1 }, ops: renameOps },
    { workflowId: 'wf-1', ops: 'renameTransition' },
    { workflowId: 'wf-1', ops: [null, 42, 'x', [], { op: '__proto__' }, { op: 'constructor' }, { op: 'toString' }, JSON.parse('{"op":"renameTransition","__proto__":{"polluted":true},"transition":"Start","newName":"X"}')] },
    { workflowId: 'wf-1', ops: [{ op: 'addStatus', name: 'x'.repeat(100000) }], instructions: 'y'.repeat(1000000) },
    { workflowId: 'wf-1', ops: Array.from({ length: 5000 }, (_, i) => ({ op: 'addStatus', name: `S${i}` })) },
  ];
  for (const payload of hostile) {
    const res = await app.handler.createPlan({ payload, context: ctxProject() });
    assert.ok(res && typeof res.ok === 'boolean', 'resolver always answers');
    if (res.ok) assert.notEqual(res.data.status, 'applied');
  }
  for (const name of ['applyPlan', 'rollbackPlan', 'discardPlan', 'getPlan']) {
    for (const payload of [null, { id: { toString: null } }, { id: '../../etc' }, { id: '__proto__' }]) {
      const res = await app.handler[name]({ payload, context: ctxProject() });
      assert.ok(res && typeof res.ok === 'boolean', `${name} answers`);
    }
  }
  assert.equal(({}).polluted, undefined, 'Object.prototype polluted');
  assert.equal(writes(j).length, 0);
  // the oversized status name never reaches Jira
  assert.ok(![...j.statuses.values()].some((s) => s.name.length > 255));
});

test('Rovo: hostile operationsJson and project keys are handled', async () => {
  const { j } = scenario();
  for (const operationsJson of ['not json', '{"op":"x"}', '[{"__proto__":{"admin":true},"op":"renameTransition"}]', 'null', '[]']) {
    const res = await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'x', operationsJson });
    assert.ok(res && typeof res === 'object');
    assert.notEqual(res.status, 'applied');
  }
  for (const projectKey of ['ALP" OR 1=1', '../ALP', 'NOPE', '']) {
    const res = await app.actOverview({ projectKey });
    assert.ok(res.error, `expected an error for ${projectKey}`);
  }
  assert.equal(({}).admin, undefined);
  assert.equal(writes(j).length, 0);
});

test('bulk: limits, unknown workflows, shared confirmation and non-plannable children', async () => {
  const { j } = scenario();
  j.strictWorkflowIds = true;
  j.addWorkflow(j.workflows.get('wf-1'), { projectId: '300', issueTypeIds: ['1'] });
  const many = await call('siteBulkCreate', { workflowIds: Array.from({ length: 250 }, (_, i) => `wf-x${i}`), ops: renameOps }, ctxSite());
  assert.equal(many.ok, false, 'more than 200 targets must be refused, not silently truncated');
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-1', 'wf-missing', 'wf-2'], ops: renameOps }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  const st = Object.fromEntries(bulk.children.map((c) => [c.workflowId, c.status]));
  assert.equal(st['wf-1'], 'planned');
  assert.equal(st['wf-missing'], 'invalid');
  assert.match(bulk.children.find((c) => c.workflowId === 'wf-missing').error, /not exist|not found/i);
  assert.equal(st['wf-2'], 'invalid', JSON.stringify(bulk.children));
  assert.equal((await call('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-2' }, ctxSite())).ok, false);
  const needs = await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-1' }, ctxSite());
  assert.equal(needs.status, 'planned');
  assert.equal(needs.needsShared, true);
  // a transient Jira failure keeps the workflow retryable inside the bulk change
  j.faults.push({ match: /POST \/rest\/api\/3\/workflows\/update$/, status: 503, times: 3 });
  const transient = await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-1', confirmShared: true }, ctxSite());
  assert.equal(transient.status, 'planned', transient.error);
  assert.equal(writes(j).length, 0);
  assert.equal(j.log.filter((l) => /^FAULT/.test(l)).length, 1, 'a write that may have been processed is never resent');
  j.faults.length = 0;
  const applied = await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-1', confirmShared: true }, ctxSite());
  assert.equal(applied.status, 'applied');
  assert.equal(writes(j).length, 1);
});

test('bulk: parallel batch planning never plans a workflow twice', async () => {
  scenario();
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-1', 'wf-2', 'wf-3'], ops: [{ op: 'replaceReference', refType: 'group', ref: 'legal', with: 'buyers' }] }, ctxSite());
  await Promise.all([ok('siteBulkPlanBatch', { bulkId: bulk.id, limit: 2 }, ctxSite()), ok('siteBulkPlanBatch', { bulkId: bulk.id, limit: 2 }, ctxSite())]);
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  assert.equal(bulk.children.length, 3);
  assert.ok(bulk.children.every((c) => c.status !== 'pending'));
  const planIds = bulk.children.map((c) => c.planId).filter(Boolean);
  assert.equal(new Set(planIds).size, planIds.length);
});

test('scale: 300 statuses / 2000 transitions load, plan and apply within limits', async () => {
  const { j } = scenario();
  const ids = Array.from({ length: 300 }, (_, i) => j.addStatus(`Stage ${i}`, i === 299 ? 'DONE' : 'IN_PROGRESS'));
  const transitions = [{ id: '1', name: 'Create', type: 'INITIAL', toStatusReference: ids[0], links: [], actions: [], validators: [], triggers: [], properties: {} }];
  for (let i = 0; i < 2000; i++) {
    transitions.push({ id: String(100 + i), name: `Move ${i}`, type: 'DIRECTED', toStatusReference: ids[(i * 7 + 1) % 300], links: [{ fromStatusReference: ids[i % 300] }], conditions: i % 3 ? undefined : { operation: 'ALL', conditions: [{ ruleKey: 'system:restrict-issue-transition', parameters: { groupIds: G.legal } }], conditionGroups: [] }, actions: [], validators: [], triggers: [], properties: { 'jira.permission.edit.group': 'legal' } });
  }
  j.addWorkflow({ id: 'wf-big', name: 'Huge Workflow', scope: { type: 'GLOBAL' }, statuses: ids.map((s) => ({ statusReference: s, properties: {} })), transitions }, { projectId: '100', issueTypeIds: ['2'] });
  let t0 = Date.now();
  const data = await ok('getProjectData');
  assert.ok(data.bundle.workflows.some((w) => w.id === 'wf-big'));
  assert.ok(Date.now() - t0 < 10000, `load took ${Date.now() - t0} ms`);
  t0 = Date.now();
  const plan = await ok('createPlan', { workflowId: 'wf-big', ops: [{ op: 'replaceReference', refType: 'group', ref: 'legal', with: 'buyers' }] });
  assert.equal(plan.status, 'planned', JSON.stringify(plan.results));
  const applied = await ok('applyPlan', { id: plan.id });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  assert.ok(Date.now() - t0 < 20000, `plan+apply took ${Date.now() - t0} ms`);
  assert.ok(!JSON.stringify(j.workflows.get('wf-big')).includes(G.legal));
  const rolled = await ok('rollbackPlan', { id: plan.id });
  assert.equal(rolled.status, 'rolledback');
  assert.equal(JSON.stringify(j.workflows.get('wf-big')).split(G.legal).length - 1, 667);
});

test('monitoring survives a project the app can no longer read', async () => {
  const { j } = scenario();
  await ok('setMonitoring', { enabled: true });
  await ok('setMonitoring', { enabled: true }, ctxProject('200', 'TMP'));
  j.faults.push({ match: /projectAndIssueTypes|project\/100/, status: 403, times: -1 });
  await assert.doesNotReject(() => app.monitor ? app.monitor({}) : Promise.resolve());
});

test('the same unchanged plan cannot be applied after it was rolled back', async () => {
  const { j } = scenario();
  const before = shape(j.workflows.get('wf-1'));
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  await ok('applyPlan', { id: plan.id });
  await ok('rollbackPlan', { id: plan.id });
  assert.equal((await call('applyPlan', { id: plan.id })).ok, false);
  assert.deepEqual(shape(j.workflows.get('wf-1')), before);
});

test('bulk across 60 workflows: no plan of the bulk is evicted, every child can be applied and rolled back', async () => {
  const { j } = scenario();
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const w = JSON.parse(JSON.stringify(j.workflows.get('wf-2')));
    w.id = `wf-b${i}`;
    w.name = `Bulk ${i}`;
    j.addWorkflow(w, { projectId: '300', issueTypeIds: [`b${i}`] });
    ids.push(w.id);
  }
  let bulk = await ok('siteBulkCreate', { workflowIds: ids, ops: [{ op: 'renameTransition', transition: 'Fix', newName: 'Resolve' }] }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id, limit: 10 }, ctxSite());
  assert.ok(bulk.children.every((c) => c.status === 'planned'), JSON.stringify(bulk.children.filter((c) => c.status !== 'planned').slice(0, 2)));
  for (const c of bulk.children) assert.equal((await ok('siteBulkApply', { bulkId: bulk.id, workflowId: c.workflowId }, ctxSite())).status, 'applied');
  // more plans afterwards must not make the applied ones impossible to roll back
  for (let i = 0; i < 60; i++) await ok('createPlan', { workflowId: 'wf-1', ops: renameOps });
  let b2 = await ok('siteBulkCreate', { workflowIds: ['wf-2'], ops: [{ op: 'renameTransition', transition: 'Fix', newName: 'Repair' }] }, ctxSite());
  while (b2.children.some((c) => c.status === 'pending')) b2 = await ok('siteBulkPlanBatch', { bulkId: b2.id }, ctxSite());
  for (const c of bulk.children.slice(0, 3)) assert.equal((await ok('siteBulkRollback', { bulkId: bulk.id, workflowId: c.workflowId }, ctxSite())).status, 'rolledback');
});

test('operation lists are never silently truncated', async () => {
  scenario();
  const many = Array.from({ length: 61 }, (_, i) => ({ op: 'addStatus', name: `S${i}` }));
  assert.equal((await call('createPlan', { workflowId: 'wf-1', ops: many })).ok, false);
  assert.equal((await call('siteBulkCreate', { workflowIds: ['wf-1'], ops: many }, ctxSite())).ok, false);
});

test('bulk: team-managed workflows can be changed and rolled back by a Jira admin', async () => {
  const { j } = scenario();
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-3'], ops: [{ op: 'renameTransition', transition: 'Done', newName: 'Finish' }] }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  assert.equal(bulk.children[0].status, 'planned');
  const applied = await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-3' }, ctxSite());
  assert.equal(applied.status, 'applied', applied.error);
  assert.ok(j.workflows.get('wf-3').transitions.some((t) => t.name === 'Finish'));
  assert.equal((await ok('siteBulkRollback', { bulkId: bulk.id, workflowId: 'wf-3' }, ctxSite())).status, 'rolledback');
});

test('rollback after a status removal does not falsely report a colleague change (live finding: Jira bumps the version twice)', async () => {
  const { j, S } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'removeStatus', status: 'Archived', moveIssuesTo: 'Open' }] });
  await ok('applyPlan', { id: plan.id });
  j.workflows.get('wf-1').version.versionNumber += 3; // background version bumps without content change
  const rolled = await call('rollbackPlan', { id: plan.id });
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.ok(j.workflows.get('wf-1').statuses.some((s) => s.statusReference === S.archived));
});
