/**
 * End-to-end tests of the real backend code (resolvers, plans, bulk changes, Rovo actions, monitoring) against
 * FakeJira. Run with: node --test --experimental-test-module-mocks tests/backend.e2e.test.js
 *
 * @file        tests/backend.e2e.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, store, monitorRun, normalize, G, scenario, ctxProject, ctxSite, call, ok, shape } from './support/harness.js';

// ------------------------------------------------------------------ tests
test('project data loads with issue-type mapping, references and findings', async () => {
  scenario();
  const data = await ok('getProjectData');
  assert.equal(data.bundle.workflows.length, 2);
  assert.deepEqual(data.bundle.mapping.map((m) => `${m.issueTypeId}:${m.workflowId}`).sort(), ['1:wf-1', '2:wf-2']);
  const model = normalize(data.bundle);
  assert.ok(model.findings.some((f) => f.code === 'DONE_NO_RESOLUTION' && f.tName === 'Reject'));
  assert.ok(Object.values(model.index.group).some((g) => g.name === 'old-team' && g.usages.some((u) => u.kind === 'property')), 'group in status property is indexed');
  // screens cannot be read with the app's scopes (live): no warning, no false 'deleted screen' finding
  assert.ok(!data.bundle.warnings.some((w) => /screens/.test(w)), data.bundle.warnings.join());
  assert.ok(!model.findings.some((f) => f.code === 'UNRESOLVED_REF' && f.params?.type === 'screen'));
});

test('permissions are enforced for project and site resolvers', async () => {
  const { j } = scenario();
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin.clear();
  assert.equal((await call('getProjectData')).error, 'FORBIDDEN_PROJECT');
  assert.equal((await call('applyPlan', { id: 'x' })).error, 'FORBIDDEN_PROJECT');
  assert.equal((await call('siteScanPage', {}, ctxSite())).error, 'FORBIDDEN_SITE');
  assert.equal((await call('siteBulkCreate', { workflowIds: ['wf-1'], ops: [{ op: 'addStatus', name: 'x' }] }, ctxSite())).error, 'FORBIDDEN_SITE');
  // a site resolver cannot be called from the project page module
  j.perms.ADMINISTER = true;
  assert.equal((await call('siteScanPage', {}, ctxProject())).error, 'FORBIDDEN_SITE');
});

test('Autopilot: plan → validate → apply → rollback restores the workflow exactly', async () => {
  const { j } = scenario();
  const before = shape(j.workflows.get('wf-1'));
  const plan = await ok('createPlan', { workflowId: 'wf-1', instructions: 'escalation', ops: [
    { op: 'addStatus', name: 'Escalated', category: 'IN_PROGRESS' },
    { op: 'addTransition', name: 'Escalate', from: ['Review'], to: 'Escalated' },
    { op: 'restrictTransition', transition: 'Escalate', groups: ['legal'] },
    { op: 'setResolution', transition: '@done', resolution: 'Done' },
  ] });
  assert.equal(plan.status, 'planned', JSON.stringify(plan.results));
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation));
  assert.equal(j.workflows.get('wf-1').version.versionNumber, 0, 'planning must not change Jira');

  const applied = await ok('applyPlan', { id: plan.id });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  const after = j.workflows.get('wf-1');
  assert.equal(after.version.versionNumber, 1);
  assert.ok(after.transitions.some((t) => t.name === 'Escalate'));
  assert.ok(after.transitions.find((t) => t.name === 'Reject').actions.some((a) => a.parameters.field === 'resolution'), '@done selector reached the global Reject transition');
  assert.ok((await store.listSnapshots('100')).some((s) => /Autopilot: before/.test(s.label)), 'safety snapshot stored');

  const rolled = await ok('rollbackPlan', { id: plan.id });
  assert.equal(rolled.status, 'rolledback');
  assert.deepEqual(shape(j.workflows.get('wf-1')), before, 'rollback restores the original structure');
  assert.equal((await call('rollbackPlan', { id: plan.id })).ok, false, 'second rollback is refused');
});

test('removing a status with issues migrates them; rollback brings the status back (live bug regression)', async () => {
  const { j, S } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'removeStatus', status: 'Archived', moveIssuesTo: 'Open' }] });
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation));
  const applied = await ok('applyPlan', { id: plan.id });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  assert.equal(j.issues.filter((i) => i.statusId === S.archived).length, 0);
  assert.equal(j.issues.filter((i) => i.statusId === S.open).length, 2);
  const rolled = await ok('rollbackPlan', { id: plan.id });
  assert.equal(rolled.status, 'rolledback', JSON.stringify(rolled.rollbackErrors));
  assert.ok(j.workflows.get('wf-1').statuses.some((s) => s.statusReference === S.archived));
});

test('a concurrent edit between planning and applying is preserved (re-apply on latest version)', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Begin' }] });
  const wf = j.workflows.get('wf-1');
  wf.transitions.find((t) => t.name === 'Archive').name = 'Archive (edited by colleague)';
  wf.version = { id: 'v-other', versionNumber: 7 };
  const applied = await ok('applyPlan', { id: plan.id });
  assert.equal(applied.status, 'applied', JSON.stringify(applied.errors));
  const names = j.workflows.get('wf-1').transitions.map((t) => t.name);
  assert.ok(names.includes('Begin') && names.includes('Archive (edited by colleague)'));
});

test('shared workflows need explicit confirmation', async () => {
  const { j } = scenario();
  j.addWorkflow(j.workflows.get('wf-1'), { projectId: '300', issueTypeIds: ['1'] });
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Go' }] });
  assert.equal(plan.sharedProjects.length, 2);
  const refused = await call('applyPlan', { id: plan.id });
  assert.equal(refused.error, 'SHARED_CONFIRM');
  assert.equal(j.workflows.get('wf-1').version.versionNumber, 0);
  const applied = await ok('applyPlan', { id: plan.id, confirmShared: true });
  assert.equal(applied.status, 'applied');
});

test('team-managed: resolution is a no-op; Jira validation errors block the plan at planning time', async () => {
  const { j } = scenario();
  const ctx = ctxProject('200', 'TMP');
  const noop = await ok('createPlan', { workflowId: 'wf-3', ops: [{ op: 'setResolution', transition: '@done', resolution: 'Done' }] }, ctx);
  assert.equal(noop.status, 'nochange');
  assert.equal((await call('applyPlan', { id: noop.id }, ctx)).ok, false, 'no-change plans cannot be applied');
  j.forceValidationError = 'Jira says no';
  const bad = await ok('createPlan', { workflowId: 'wf-3', ops: [{ op: 'renameTransition', transition: 'Done', newName: 'Finish' }] }, ctx);
  assert.equal(bad.status, 'invalid');
  assert.deepEqual(bad.validation.errors, ['Jira says no']);
});

test('rate limiting (429) is retried transparently', async () => {
  const { j } = scenario();
  j.rateLimitEvery = 3;
  const data = await ok('getProjectData');
  assert.equal(data.bundle.workflows.length, 2);
  assert.ok(j.log.length > 10);
});

test('bulk: replace a group in all workflows, skip unaffected ones, roll everything back', async () => {
  const { j } = scenario();
  const before = shape(j.workflows.get('wf-1'));
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-1', 'wf-2', 'wf-3'], ops: [{ op: 'replaceReference', refType: 'group', ref: 'legal', with: 'buyers' }], instructions: 'legal → buyers' }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  const st = Object.fromEntries(bulk.children.map((c) => [c.workflowId, c.status]));
  assert.deepEqual(st, { 'wf-1': 'planned', 'wf-2': 'nochange', 'wf-3': 'nochange' });
  const ch = await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-1' }, ctxSite());
  assert.equal(ch.status, 'applied', ch.error);
  const approve = j.workflows.get('wf-1').transitions.find((t) => t.name === 'Approve');
  assert.equal(approve.conditions.conditions[0].parameters.groupIds, G.buy, 'deduplicated buyers,legal → buyers');
  assert.equal(j.workflows.get('wf-1').transitions.find((t) => t.name === 'Start').conditions.conditions[0].parameters.groupIds, G.buy);
  const rb = await ok('siteBulkRollback', { bulkId: bulk.id, workflowId: 'wf-1' }, ctxSite());
  assert.equal(rb.status, 'rolledback', rb.error);
  assert.deepEqual(shape(j.workflows.get('wf-1')), before);
  const list = await ok('siteBulkList', {}, ctxSite());
  assert.equal(list[0].id, bulk.id);
});

test('bulk: removing a group also cleans transition/status properties', async () => {
  const { j } = scenario();
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-1'], ops: [{ op: 'removeReference', refType: 'group', ref: 'old-team' }] }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  assert.equal(bulk.children[0].status, 'planned');
  await ok('siteBulkApply', { bulkId: bulk.id, workflowId: 'wf-1' }, ctxSite());
  const review = j.workflows.get('wf-1').statuses.find((s) => s.properties && Object.keys(s.properties).length === 0 && s.statusReference);
  assert.ok(review);
  assert.ok(!JSON.stringify(j.workflows.get('wf-1')).includes('old-team'));
});

test('AI Copilot: tool-call plan is created and validated; unclear requests create no plan', async () => {
  scenario();
  state.llm.push({ choices: [{ message: { tool_calls: [{ function: { name: 'propose_workflow_changes', arguments: JSON.stringify({ explanation: 'ok', operations: [{ op: 'addTransition', transition: 'Reopen', fromStatus: 'Done', toStatus: 'Open' }] }) } }] } }] });
  const res = await ok('aiPlan', { instructions: 'reopen please', workflowId: 'wf-1', lang: 'en' });
  assert.equal(res.plan.status, 'planned', JSON.stringify(res.plan.results));
  state.llm.push({ choices: [{ message: { tool_calls: [{ function: { name: 'propose_workflow_changes', arguments: JSON.stringify({ explanation: 'Which status?', operations: [] }) } }] } }] });
  const none = await ok('aiPlan', { instructions: '???', workflowId: 'wf-1' });
  assert.equal(none.plan, null);
  state.llm.push(() => { throw new Error('model down'); });
  assert.equal((await call('aiPlan', { instructions: 'x', workflowId: 'wf-1' })).ok, false, 'LLM failures surface as errors, not crashes');
  state.llm.push(() => { throw new Error('403 Forbidden: AI features are disabled for this organization'); });
  const off = await call('aiPlan', { instructions: 'x', workflowId: 'wf-1' });
  assert.equal(off.error, 'AI_UNAVAILABLE');
  assert.match(off.message, /not available/);
});

test('Rovo actions: list usage check, plan + apply, unauthorized users', async () => {
  const { j } = scenario();
  const usage = await app.actFindUsages({ projectKey: 'ALP', searchTerm: 'legal, old-team, nobody', objectType: 'group' });
  const used = Object.fromEntries(usage.results.map((r) => [r.term, r.usedInWorkflows]));
  assert.deepEqual(used, { legal: true, 'old-team': true, nobody: false });
  const plan = await app.actPlanChange({ projectKey: 'ALP', workflowName: 'Alpha', instructions: 'rename', operationsJson: JSON.stringify([{ op: 'renameTransition', transition: 'Start', newName: 'Kick-off' }]) });
  assert.equal(plan.status, 'planned', JSON.stringify(plan));
  const applied = await app.actApplyChange({ projectKey: 'ALP', planId: plan.planId });
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  assert.ok(j.workflows.get('wf-1').transitions.some((t) => t.name === 'Kick-off'));
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin.clear();
  assert.match((await app.actOverview({ projectKey: 'ALP' })).error, /not available/);
  assert.match((await app.actOverview({})).error, /No project key/);
});

test('remediation tasks are created once (no duplicates)', async () => {
  const { j } = scenario();
  const items = [{ fingerprint: 'fp-1', summary: 'Fix A', description: { type: 'doc', version: 1, content: [] } }, { fingerprint: 'fp-2', summary: 'Fix B', description: { type: 'doc', version: 1, content: [] } }];
  const first = await ok('createRemediation', { items, issueTypeId: '1' });
  assert.equal(first.created.length, 2);
  const second = await ok('createRemediation', { items, issueTypeId: '1' });
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped.length, 2);
  assert.equal(j.issues.filter((i) => i.labels?.includes('workflow-health')).length, 2);
});

test('large snapshots are chunked in KVS and read back intact', async () => {
  scenario();
  const big = { v: 1, takenAt: new Date().toISOString(), label: 'big', stats: {}, workflows: [{ id: 'x', n: 'x', it: [], s: [], t: Array.from({ length: 4000 }, (_, i) => ({ i: String(i), n: `Transition ${i} ${'x'.repeat(80)}`, y: 'DIRECTED', f: ['A'], to: 'B', sc: null, r: [] })) }] };
  const entry = await store.saveSnapshot('100', big);
  assert.ok(entry.chunks > 1, `expected chunks, got ${entry.chunks}`);
  assert.deepEqual(await store.getSnapshot('100', entry.id), big);
});

test('monitoring: baseline first, then detects a change', async () => {
  const { j } = scenario();
  const on = await ok('setMonitoring', { enabled: true });
  assert.ok(on.state.baselineAt);
  j.workflows.get('wf-1').transitions.find((t) => t.name === 'Start').name = 'Start (changed)';
  j.workflows.get('wf-1').version.versionNumber++;
  await monitorRun();
  const st = await store.getMonitorState('100');
  assert.ok(st.lastChangeAt && st.lastChangeCount > 0, JSON.stringify(st));
  const visit = await ok('touchVisit');
  assert.ok(visit.state.lastChangeAt);
});

test('status load counts match the issues in Jira', async () => {
  const { S } = scenario();
  const load = await ok('getStatusLoad', { statusIds: [S.open, S.review, S.done, S.archived], staleDays: 30 });
  assert.equal(load.byStatus[S.archived].count, 2);
  assert.equal(load.byStatus[S.review].stale, 1);
  assert.equal(load.byStatus[S.done].count, 0);
  assert.equal(load.all, 3);
  const bad = await ok('getStatusLoad', { statusIds: ['1 OR project = OTHER', '<script>'] });
  assert.deepEqual(Object.keys(bad.byStatus), [], 'non-numeric status IDs are rejected (JQL injection)');
});
