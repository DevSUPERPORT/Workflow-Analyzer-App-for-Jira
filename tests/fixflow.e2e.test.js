// End-to-end tests for the "insight to fix" flows: one-click fixes for chosen findings, re-planning stale
// plans and plan messages in the planner's language. Assertions are made on what Jira ends up containing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, scenario, ctxProject, ctxSite, call, ok, shape, normalize } from './support/harness.js';
import { findingFingerprint, findingKey } from '../src/shared/insights.js';
import { autofixOperations, resolutionFor } from '../src/shared/autopilot.js';

const writes = (j) => j.log.filter((l) => /^[AU] POST \/rest\/api\/3\/workflows\/update$/.test(l));
const findings = async () => {
  const { bundle } = await ok('getProjectData', {});
  return { model: normalize(bundle), bundle };
};

test('fix one finding: the plan contains only its fix, picks a fitting resolution, applies and rolls back cleanly', async () => {
  const { j } = scenario();
  const before = shape(j.workflows.get('wf-1'));
  const { model, bundle } = await findings();
  const target = model.findings.find((f) => f.code === 'DONE_NO_RESOLUTION' && f.wfId === 'wf-1');
  assert.ok(target, 'scenario has a Done transition without resolution');
  // more than one fixable finding exists, so "only this one" is a real restriction
  assert.ok(autofixOperations(model, model.findings, bundle.ref.resolutions).ops.length >= 1);

  const plan = await ok('autofixPlan', { workflowId: 'wf-1', fingerprints: [findingFingerprint(target)], lang: 'en' });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.ops[0], { op: 'setResolution', transition: '31', resolution: "Won't Do" }, 'a rejection is not resolved as Done');
  assert.ok(plan.fixed.some((f) => f.code === 'DONE_NO_RESOLUTION'));
  assert.match(plan.title, /^Auto-fix 1 finding in "Alpha Workflow"$/);
  assert.match(plan.results[0].message, /^Reject: Sets resolution "Won't Do"$/);

  const applied = await ok('applyPlan', { id: plan.id });
  assert.equal(applied.status, 'applied');
  const reject = j.workflows.get('wf-1').transitions.find((t) => t.id === '31');
  assert.ok(reject.actions.some((a) => a.ruleKey === 'system:update-field' && a.parameters.field === 'resolution' && a.parameters.value === '10001'));
  await ok('rollbackPlan', { id: plan.id });
  assert.deepEqual(shape(j.workflows.get('wf-1')), before, 'rollback restores the exact workflow');
});

test('a finding without an automatic fix creates no plan and says so', async () => {
  const { j } = scenario();
  const { model, bundle } = await findings();
  const manual = model.findings.find((f) => f.severity !== 'info' && !autofixOperations(model, [f], bundle.ref.resolutions).ops.length);
  assert.ok(manual, 'scenario has a finding that needs a human');
  const res = await call('autofixPlan', { workflowId: manual.wfId, fingerprints: [findingFingerprint(manual)], lang: 'de' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NOTHING_TO_FIX');
  assert.match(res.message, /keine automatische Korrektur/);
  assert.deepEqual(await ok('listPlans', {}), []);
  // unknown fingerprints behave the same (findings may have been fixed by someone else meanwhile)
  assert.equal((await call('autofixPlan', { workflowId: 'wf-1', fingerprints: ['nope|wf-1'] })).error, 'NOTHING_TO_FIX');
  assert.equal(writes(j).length, 0);
});

test('fingerprints cannot reach findings of a workflow the project does not use', async () => {
  const { j } = scenario();
  // wf-3 belongs to the team-managed project 200; from project 100 it is not addressable
  const res = await call('autofixPlan', { workflowId: 'wf-3', fingerprints: ['DONE_NO_RESOLUTION|wf-3|||||{}'] });
  assert.equal(res.ok, false);
  assert.equal(writes(j).length, 0);
});

test('plan messages follow the planner\'s language; English stays the default', async () => {
  scenario();
  const ops = [{ op: 'renameTransition', transition: '11', newName: 'Begin' }, { op: 'removeTransition', transition: 'Nope' }];
  const de = await ok('createPlan', { workflowId: 'wf-1', ops, lang: 'de' });
  assert.equal(de.results[0].message, '„Start“ → „Begin“', 'transition IDs are shown by name');
  assert.match(de.results[1].message, /^Transition „Nope“ im Workflow „Alpha Workflow“ nicht gefunden$/);
  const en = await ok('createPlan', { workflowId: 'wf-1', ops });
  assert.equal(en.results[0].message, '"Start" → "Begin"');
  assert.match(en.results[1].message, /not found/);
  // the apply re-check reports in the plan's language too
  const applied = await ok('applyPlan', { id: de.id });
  assert.equal(applied.applyResults[0].message, '„Start“ → „Begin“');
});

test('re-plan: an expired plan is planned again on the current workflow, the old one is discarded', async () => {
  const { j } = scenario();
  const plan = await ok('createPlan', { workflowId: 'wf-1', ops: [{ op: 'renameTransition', transition: 'Start', newName: 'Begin' }], instructions: 'Rename start' });
  const key = [...state.kvs.keys()].find((k) => state.kvs.get(k)?.id === plan.id && state.kvs.get(k)?.ops);
  state.kvs.set(key, { ...state.kvs.get(key), createdAt: '2020-01-01T00:00:00Z' });
  // meanwhile a colleague changed the workflow
  const wf = j.workflows.get('wf-1');
  wf.transitions.find((t) => t.name === 'Archive').name = 'Archive (colleague)';
  wf.version = { id: 'v-next', versionNumber: wf.version.versionNumber + 1 };
  assert.match((await call('applyPlan', { id: plan.id })).message, /expired/i);

  const fresh = await ok('replanPlan', { id: plan.id, lang: 'en' });
  assert.notEqual(fresh.id, plan.id);
  assert.equal(fresh.replaces, plan.id);
  assert.equal(fresh.status, 'planned');
  assert.equal(fresh.instructions, 'Rename start');
  assert.deepEqual(fresh.ops, plan.ops);
  assert.equal(fresh.baseVersion.versionNumber, wf.version.versionNumber, 'planned on the current version');
  assert.equal((await ok('getPlan', { id: plan.id })).status, 'discarded');
  await ok('applyPlan', { id: fresh.id });
  const names = j.workflows.get('wf-1').transitions.map((t) => t.name);
  assert.ok(names.includes('Begin') && names.includes('Archive (colleague)'), 'the colleague\'s change is kept');
  // applied plans are not re-planned (their rollback stays tied to them)
  assert.match((await call('replanPlan', { id: fresh.id })).message, /applied/);
});

test('re-plan keeps the access rules: another project\'s plan cannot be re-planned', async () => {
  const { j } = scenario();
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin = new Set(['100', '200']);
  const tmp = ctxProject('200', 'TMP');
  const foreign = await ok('createPlan', { workflowId: 'wf-3', ops: [{ op: 'renameTransition', transition: 'Done', newName: 'Fin' }] }, tmp);
  const res = await call('replanPlan', { id: foreign.id });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/i);
  j.perms.projectAdmin = new Set(['200']);
  assert.equal((await call('replanPlan', { id: foreign.id })).error, 'FORBIDDEN_PROJECT');
  assert.equal((await ok('getPlan', { id: foreign.id }, tmp)).status, 'planned');
});

test('resolution choice: rejections, cancellations and duplicates get the resolution that says so', () => {
  const res = [{ id: '1', name: 'Done' }, { id: '2', name: "Won't Do" }, { id: '3', name: 'Duplicate' }, { id: '4', name: 'Abgebrochen' }];
  const done = res[0];
  const tr = (name, to) => ({ name, to: { name: to } });
  assert.equal(resolutionFor(tr('Ablehnen', 'Nicht genehmigt'), res, done).name, "Won't Do");
  assert.equal(resolutionFor(tr('Close', 'Duplicate'), res, done).name, 'Duplicate');
  assert.equal(resolutionFor(tr('Abbrechen', 'Abgebrochen'), res, done).name, 'Abgebrochen');
  assert.equal(resolutionFor(tr('Approve', 'Done'), res, done).name, 'Done');
  assert.equal(resolutionFor(tr('Reject', 'Rejected'), [done], done).name, 'Done', 'falls back when the site has no such resolution');
});

test('site-wide fix: one bulk change plans each workflow with its own fixes, applies and rolls back per workflow', async () => {
  const { j } = scenario();
  // a second workflow with the same kind of finding
  j.workflows.get('wf-2').transitions.find((t) => t.name === 'Fix').actions = [];
  const before = { 'wf-1': shape(j.workflows.get('wf-1')), 'wf-2': shape(j.workflows.get('wf-2')) };
  const { model } = await findings();
  const chosen = model.findings.filter((f) => f.code === 'DONE_NO_RESOLUTION');
  assert.deepEqual([...new Set(chosen.map((f) => f.wfId))].sort(), ['wf-1', 'wf-2']);
  const site = ctxSite();
  // project admins cannot start it
  j.perms.ADMINISTER = false;
  assert.equal((await call('siteBulkCreate', { workflowIds: ['wf-1'], autofix: { fingerprints: chosen.map(findingFingerprint) } }, site)).error, 'FORBIDDEN_SITE');
  j.perms.ADMINISTER = true;

  let b = await ok('siteBulkCreate', { workflowIds: ['wf-1', 'wf-2', 'wf-3'], autofix: { fingerprints: chosen.map(findingFingerprint) }, instructions: 'Auto-fix', lang: 'en' }, site);
  assert.deepEqual(b.ops, []);
  while (b.children.some((c) => c.status === 'pending')) b = await ok('siteBulkPlanBatch', { bulkId: b.id }, site);
  const by = Object.fromEntries(b.children.map((c) => [c.workflowId, c]));
  assert.equal(by['wf-1'].status, 'planned');
  assert.equal(by['wf-2'].status, 'planned');
  assert.equal(by['wf-3'].status, 'nochange', 'a workflow without the chosen findings gets no plan');
  for (const id of ['wf-1', 'wf-2']) assert.equal((await ok('siteBulkApply', { bulkId: b.id, workflowId: id }, site)).status, 'applied');
  assert.ok(j.workflows.get('wf-1').transitions.find((t) => t.id === '31').actions.some((a) => a.parameters?.value === '10001'), 'Reject → Won\'t Do');
  assert.ok(j.workflows.get('wf-2').transitions.find((t) => t.name === 'Fix').actions.some((a) => a.parameters?.value === '10000'), 'Fix → Done');
  for (const id of ['wf-1', 'wf-2']) assert.equal((await ok('siteBulkRollback', { bulkId: b.id, workflowId: id }, site)).status, 'rolledback');
  assert.deepEqual(shape(j.workflows.get('wf-1')), before['wf-1']);
  assert.deepEqual(shape(j.workflows.get('wf-2')), before['wf-2']);
});

test('visit digest: the previous visit\'s finding keys come back once per visit; junk keys are dropped', async () => {
  scenario();
  const { model } = await findings();
  const keys = model.findings.filter((f) => f.severity !== 'info').map(findingKey);
  assert.ok(keys.every((k) => /^[a-z0-9]{1,16}$/.test(k)));
  assert.equal(new Set(keys).size, keys.length, 'keys are distinct');
  const first = await ok('touchVisit', { findings: keys.slice(1) });
  assert.equal(first.previous, null, 'nothing to compare on the first visit');
  const second = await ok('touchVisit', { findings: [...keys, '__proto__', 'x'.repeat(40), { a: 1 }] });
  assert.deepEqual(second.previous.keys, keys.slice(1));
  const third = await ok('touchVisit', { findings: keys });
  assert.deepEqual(third.previous.keys, keys, 'hostile entries were not stored');
  // other users have their own memory
  const other = { ...ctxProject(), accountId: 'user-other' };
  assert.equal((await ok('touchVisit', { findings: keys }, other)).previous, null);
});
