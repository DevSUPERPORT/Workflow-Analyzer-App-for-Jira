// Privilege escalation: every entry point (UI resolvers and Rovo actions) is called the way an attacker would –
// with another project's IDs, from the wrong module, or as a user whose role does not allow the action.
// Each test asserts what Jira and the app's storage contain afterwards, not only the error code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, scenario, ctxProject, ctxSite, call, ok } from './support/harness.js';

const writes = (j) => j.log.filter((l) => /^[AU] POST \/rest\/api\/3\/workflows\/update$/.test(l));
const asProjectAdminOf = (j, ...ids) => { j.perms.ADMINISTER = false; j.perms.projectAdmin = new Set(ids); };
const asNobody = (j) => asProjectAdminOf(j);

// Every resolver the UI can call, with a plausible payload
const PROJECT_RESOLVERS = {
  getProjectData: {}, saveNote: { workflowId: 'wf-1', transitionId: '11', text: 'x' }, getNotes: { workflowIds: ['wf-1'] },
  listSnapshots: {}, saveSnapshot: { label: 'x' }, getSnapshot: { id: 'x' }, deleteSnapshot: { id: 'x' },
  getStatusLoad: { statusIds: ['1'] }, getIssueTypes: {}, getRemediation: {}, createRemediation: { items: [{ fingerprint: 'f', summary: 's' }], issueTypeId: '1' },
  getMonitoring: {}, setMonitoring: { enabled: true }, touchVisit: {}, aiAsk: { question: 'q' }, aiPlan: { instructions: 'x', workflowId: 'wf-1' },
  createPlan: { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'X' }] }, autofixPlan: { workflowId: 'wf-1', fingerprints: ['x'] },
  replanPlan: { id: 'x' }, listPlans: {}, getPlan: { id: 'x' }, applyPlan: { id: 'x' }, rollbackPlan: { id: 'x' }, discardPlan: { id: 'x' },
};
const SITE_RESOLVERS = {
  siteScanPage: {}, siteRefs: { ids: {} }, siteProjects: { workflowIds: ['wf-1'] }, siteBulkList: {}, siteBulkGet: { id: 'x' },
  siteBulkCreate: { workflowIds: ['wf-1'], ops: [{ op: 'renameTransition', transition: 'Start', newName: 'X' }] }, siteBulkPlanBatch: { bulkId: 'x' },
  siteBulkApply: { bulkId: 'x', workflowId: 'wf-1' }, siteBulkRollback: { bulkId: 'x', workflowId: 'wf-1' }, siteBulkAi: { instructions: 'x', workflowId: 'wf-1' },
};

test('a user without admin rights is refused by every resolver and leaves no trace', async () => {
  const { j } = scenario();
  asNobody(j);
  const kvsBefore = state.kvs.size;
  for (const [name, payload] of Object.entries(PROJECT_RESOLVERS)) {
    const res = await call(name, payload);
    assert.equal(res.ok, false, `${name} must refuse a non-admin`);
    assert.match(res.error, /^FORBIDDEN/, `${name}: ${res.error} ${res.message || ''}`);
  }
  for (const [name, payload] of Object.entries(SITE_RESOLVERS)) {
    assert.equal((await call(name, payload, ctxSite())).error, 'FORBIDDEN_SITE', name);
  }
  assert.equal(writes(j).length, 0);
  assert.equal(j.issues.filter((i) => i.labels).length, 0, 'no issue created');
  assert.equal(state.kvs.size, kvsBefore, 'nothing stored');
});

test('site resolvers cannot be reached from the project page, even by a Jira admin', async () => {
  scenario();
  for (const [name, payload] of Object.entries(SITE_RESOLVERS)) assert.equal((await call(name, payload, ctxProject())).error, 'FORBIDDEN_SITE', name);
});

test('the module key cannot be spoofed by the payload', async () => {
  const { j } = scenario();
  asProjectAdminOf(j, '100');
  const res = await app.handler.siteScanPage({ payload: { moduleKey: 'workflow-analyzer-admin', context: { moduleKey: 'workflow-analyzer-admin' } }, context: ctxProject() });
  assert.equal(res.error, 'FORBIDDEN_SITE');
});

test('notes: a project admin can neither read nor write notes of another project\'s workflow', async () => {
  const { j } = scenario();
  // a Jira admin writes a note on the team-managed workflow of project TMP
  await ok('saveNote', { workflowId: 'wf-3', transitionId: '11', text: 'secret TMP note' }, ctxProject('200', 'TMP'));
  asProjectAdminOf(j, '100');
  const read = await ok('getNotes', { workflowIds: ['wf-1', 'wf-3'] });
  assert.equal(read['wf-3'], undefined, 'foreign notes are filtered out');
  assert.ok(read['wf-1']);
  assert.equal((await call('saveNote', { workflowId: 'wf-3', transitionId: '11', text: 'overwritten' })).error, 'FORBIDDEN_PROJECT');
  const stored = state.kvs.get('notes-wf-3');
  assert.equal(stored['11'].text, 'secret TMP note');
  // own workflow works
  await ok('saveNote', { workflowId: 'wf-1', transitionId: '11', text: 'mine' });
});

test('notes: hostile IDs cannot reach other storage keys or pollute objects', async () => {
  scenario();
  for (const [workflowId, transitionId] of [['wf-1', '__proto__'], ['wf-1', 'constructor'], ['../plan-x', '11'], ['wf-1', 'a'.repeat(500)], ['wf-1', { toString: () => '11' }]]) {
    const res = await call('saveNote', { workflowId, transitionId, text: 'x' });
    assert.equal(res.ok, false, `${String(workflowId)} / ${String(transitionId).slice(0, 20)}`);
  }
  assert.equal(({}).text, undefined);
});

test('plans: a project admin cannot change a shared company-managed workflow, and cannot see names of projects hidden from them', async () => {
  const { j } = scenario();
  j.addWorkflow(j.workflows.get('wf-1'), { projectId: '300', issueTypeIds: ['1'] });
  j.hiddenFromUser = new Set(['300']);
  asProjectAdminOf(j, '100');
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Go' }] });
  assert.equal(plan.sharedProjects.length, 2);
  assert.ok(!JSON.stringify(plan.sharedProjects).includes('BET'), 'hidden project key leaked');
  assert.ok(plan.sharedProjects.some((p) => p.hidden));
  const refused = await call('applyPlan', { id: plan.id, confirmShared: true });
  assert.equal(refused.error, 'FORBIDDEN_CHANGE_GLOBAL');
  const blocked = await call('applyPlan', { id: plan.id });
  assert.ok(!/BET/.test(blocked.message || ''), 'hidden project named in the confirmation message');
  assert.equal(writes(j).length, 0);
});

test('plans: a team-managed workflow can only be changed by an admin of its own project', async () => {
  const { j } = scenario();
  asProjectAdminOf(j, '200');
  const tmp = ctxProject('200', 'TMP');
  const plan = await ok('createPlan', { workflowId: 'wf-3', ops: [{ op: 'renameTransition', transition: 'Done', newName: 'Finish' }] }, tmp);
  // admin rights on TMP are revoked between planning and applying
  asProjectAdminOf(j, '100');
  assert.equal((await call('applyPlan', { id: plan.id }, tmp)).error, 'FORBIDDEN_PROJECT');
  asProjectAdminOf(j, '200');
  assert.equal((await ok('applyPlan', { id: plan.id }, tmp)).status, 'applied');
  // and the rollback is checked again too
  asProjectAdminOf(j, '100');
  assert.equal((await call('rollbackPlan', { id: plan.id }, tmp)).error, 'FORBIDDEN_PROJECT');
});

test('bulk: rights revoked mid-way stop the next workflow', async () => {
  const { j } = scenario();
  let bulk = await ok('siteBulkCreate', { workflowIds: ['wf-1', 'wf-2'], ops: [{ op: 'renameTransition', transition: '@all', newName: 'X' }] }, ctxSite());
  while (bulk.children.some((c) => c.status === 'pending')) bulk = await ok('siteBulkPlanBatch', { bulkId: bulk.id }, ctxSite());
  j.perms.ADMINISTER = false;
  for (const ch of bulk.children) assert.equal((await call('siteBulkApply', { bulkId: bulk.id, workflowId: ch.workflowId }, ctxSite())).error, 'FORBIDDEN_SITE');
  assert.equal(writes(j).length, 0);
});

test('Rovo: no project data is read for a user who is not its admin, and unknown and forbidden projects look the same', async () => {
  const { j } = scenario();
  asProjectAdminOf(j, '100');
  j.log.length = 0;
  const forbidden = await app.actOverview({ projectKey: 'TMP' });
  const unknown = await app.actOverview({ projectKey: 'NOPE' });
  assert.equal(forbidden.error.replace('TMP', 'X'), unknown.error.replace('NOPE', 'X'), 'responses must not reveal whether a project exists');
  assert.ok(!j.log.some((l) => /^A /.test(l)), `app-permission reads happened before authorisation: ${j.log.filter((l) => /^A /.test(l)).join(' | ')}`);
  for (const act of ['actFindUsages', 'actHealth', 'actPlanChange', 'actApplyChange', 'actRollbackChange', 'actAutofix', 'actListPlans', 'actRemediate', 'actAccess', 'actCompare', 'actStatusLoad', 'actExplain']) {
    const res = await app[act]({ projectKey: 'TMP', searchTerm: 'x', planId: 'x', instructions: 'x', operationsJson: '[]' });
    assert.ok(res?.error, `${act} must refuse`);
  }
  assert.equal(writes(j).length, 0);
});

test('capabilities reported to the UI match each role', async () => {
  const { j } = scenario();
  const caps = async (ctx) => (await ok('bootstrap', {}, ctx)).caps;
  let c = await caps(ctxProject());
  assert.equal(c.role, 'jira-admin');
  assert.equal(c.changeShared, true);
  assert.equal(c.bulk, false, 'bulk only on the site page');
  assert.equal((await caps(ctxSite())).bulk, true);
  asProjectAdminOf(j, '100');
  c = await caps(ctxProject());
  assert.deepEqual([c.role, c.changeShared, c.changeProjectScoped, c.bulk], ['project-admin', false, true, false]);
  assert.equal((await ok('bootstrap', {}, ctxSite())).allowed, false);
  asNobody(j);
  const b = await ok('bootstrap', {}, ctxProject());
  assert.equal(b.allowed, false);
  assert.equal(b.caps.role, 'none');
});
