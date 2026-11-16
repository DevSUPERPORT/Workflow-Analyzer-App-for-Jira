/**
 * Issue resolution check and repair, end to end through the real resolvers against FakeJira: counts, listing,
 * compare-and-set repairs, clearing via self-transitions, undo runs, permissions and the Rovo action.
 *
 * @file        tests/resolutions.e2e.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { state, scenario, ok, call, ctxProject, ctxSite, app } from './support/harness.js';

function seed() {
  const { j, S } = scenario();
  // ALP: two Done issues without resolution, one correctly resolved, one open issue still carrying a resolution
  const a = j.addIssue({ projectId: '100', statusId: S.done, summary: 'Shipped but unresolved', updated: '2026-10-20T10:00:00Z' });
  const b = j.addIssue({ projectId: '100', statusId: S.done, summary: 'Also unresolved', updated: '2026-10-21T10:00:00Z' });
  j.addIssue({ projectId: '100', statusId: S.done, resolution: '10000' });
  const c = j.addIssue({ projectId: '100', statusId: S.open, resolution: '10000', summary: 'Reopened, still resolved' });
  // BET: another project – never touched from the ALP page
  const other = j.addIssue({ projectId: '300', statusId: S.done });
  // Like Jira's simplified workflows: a global transition into Open whose post function clears the resolution.
  // Jira Cloud offers it even to issues already in Open – the only way it clears a resolution without moving the issue.
  j.workflows.get('wf-1').transitions.push({ id: '61', name: 'Reopen', type: 'GLOBAL', toStatusReference: S.open, links: [], actions: [{ ruleKey: 'system:update-field', parameters: { field: 'resolution', value: '', mode: '' } }], validators: [], triggers: [], properties: {} });
  return { j, S, a, b, c, other };
}

test('audit counts both kinds of damage, project page scoped to its own project', async () => {
  seed();
  const audit = await ok('resolutionAudit', { projectKey: 'BET' });
  assert.equal(audit.projectKey, 'ALP', 'project comes from the Forge context, never from the payload');
  assert.equal(audit.doneUnresolved, 2);
  assert.equal(audit.openResolved, 1);
  const site = await ok('resolutionAudit', {}, ctxSite());
  assert.equal(site.doneUnresolved, 3);
  assert.equal((await ok('resolutionAudit', { projectKey: 'BET' }, ctxSite())).doneUnresolved, 1);
});

test('lists the affected issues newest first with status and resolution', async () => {
  seed();
  const page = await ok('resolutionIssues', { kind: 'doneUnresolved' });
  assert.deepEqual(page.issues.map((i) => i.summary), ['Also unresolved', 'Shipped but unresolved']);
  assert.equal(page.issues[0].status.category, 'DONE');
  assert.equal(page.issues[0].resolution, null);
  const open = await ok('resolutionIssues', { kind: 'openResolved' });
  assert.equal(open.issues[0].resolution.name, 'Done');
  assert.equal((await call('resolutionIssues', { kind: 'bogus' })).ok, false);
});

test('Jira admin repairs in place without notifications; undo restores; repeats are no-ops', async () => {
  const { j, a, b, c } = seed();
  const items = [{ key: a.key, from: null, to: '10000' }, { key: b.key, from: null, to: '10001' }];
  const res = await ok('resolutionRepair', { items, runId: 'run000001', kind: 'doneUnresolved' });
  assert.deepEqual(res.results.map((r) => r.status), ['repaired', 'repaired']);
  assert.equal(res.silent, true);
  assert.equal(a.resolution, '10000');
  assert.equal(b.resolution, '10001');
  assert.ok(j.edits.every((e) => e.notify === false), 'no notification mails');
  assert.equal(a.statusId, j.issues.find((i) => i.key === a.key).statusId, 'status unchanged');
  assert.equal((await ok('resolutionAudit')).doneUnresolved, 0);

  // Double click / retry: nothing changes twice
  const again = await ok('resolutionRepair', { items, runId: 'run000001', kind: 'doneUnresolved' });
  assert.deepEqual(again.results.map((r) => r.code), ['ALREADY_DONE', 'ALREADY_DONE']);

  // Run log
  const first = (await ok('resolutionRuns')).find((r) => r.id === 'run000001');
  assert.equal(first.items.length, 2);
  assert.equal(first.skipped, 2);
  // Live Jira Cloud cannot clear a resolution in place, and no transition into Done clears it: undo is refused
  // per issue, nothing changes, and the run is not marked as undone
  const undo = await ok('resolutionRepair', { items: first.items.map((i) => ({ key: i.key, from: i.to, to: i.from })), runId: 'undo000001', undoOf: 'run000001' });
  assert.deepEqual(undo.results.map((r) => r.code), ['CANNOT_CLEAR', 'CANNOT_CLEAR']);
  assert.equal(a.resolution, '10000');
  assert.equal(a.statusId, b.statusId, 'still in Done');
  assert.equal((await ok('resolutionRuns')).find((r) => r.id === 'run000001').undoneBy, undefined);
  void c;
});

test('never overwrites a change made meanwhile', async () => {
  const { a } = seed();
  a.resolution = '10001'; // a colleague resolved it as "Won't Do" after the list was loaded
  const res = await ok('resolutionRepair', { items: [{ key: a.key, from: null, to: '10000' }], runId: 'run000003' });
  assert.equal(res.results[0].code, 'CHANGED');
  assert.equal(a.resolution, '10001');
});

test('project page cannot touch issues of other projects', async () => {
  const { other } = seed();
  const res = await ok('resolutionRepair', { items: [{ key: other.key, from: null, to: '10000' }], runId: 'run000004', projectKey: 'BET' });
  assert.equal(res.results[0].code, 'OUT_OF_SCOPE');
  assert.equal(other.resolution, null);
  // The site page (Jira admins) may
  const site = await ok('resolutionRepair', { items: [{ key: other.key, from: null, to: '10000' }], runId: 'run000005' }, ctxSite());
  assert.equal(site.results[0].status, 'repaired');
});

test('project admins without Jira admin: clear message when Resolution is not on the edit screen', async () => {
  const { j, a } = seed();
  j.perms.ADMINISTER = false;
  const res = await ok('resolutionRepair', { items: [{ key: a.key, from: null, to: '10000' }], runId: 'run000006' });
  assert.equal(res.silent, false);
  assert.equal(res.results[0].code, 'NOT_ON_SCREEN');
  assert.equal(a.resolution, null);
  j.resolutionOnEditScreen = true;
  const ok2 = await ok('resolutionRepair', { items: [{ key: a.key, from: null, to: '10000' }], runId: 'run000007' });
  assert.equal(ok2.results[0].status, 'repaired');
  assert.equal(j.edits.at(-1).notify, true);
  // The site page stays closed to them
  assert.equal((await call('resolutionAudit', {}, ctxSite())).error, 'FORBIDDEN_SITE');
});

test('hostile and oversized input is rejected or ignored', async () => {
  const { a } = seed();
  const bad = await ok('resolutionRepair', { items: [{ key: 'alp-1; DROP', from: null, to: '10000' }, { key: a.key, from: null, to: '<b>' }, { key: '__proto__' }], runId: 'run000008' });
  assert.equal(bad.results.length, 0);
  const many = Array.from({ length: 21 }, (_, i) => ({ key: `ALP-${100 + i}`, from: null, to: '10000' }));
  assert.equal((await call('resolutionRepair', { items: many, runId: 'run000009' })).ok, false);
  assert.equal((await call('resolutionAudit', { projectKey: 'x" OR 1=1' }, ctxSite())).ok, false);
  assert.equal((await call('resolutionRepair', { items: [], runId: '../../etc' })).ok, true, 'empty batch is fine');
  // Nothing was repaired or failed, so no "Repair of 0 issues" entry lands in the history; no key escapes the scope
  assert.equal(state.kvs.has('resfix-p-100'), false, 'a run that changed nothing is not logged');
  assert.ok(![...state.kvs.keys()].some((k) => k.includes('..') || k.includes('etc')), 'hostile run IDs never become storage keys');
});

test('a repair failing mid-batch reports per issue and keeps the others', async () => {
  const { j, a, b } = seed();
  j.faults.push({ match: new RegExp(`PUT .*issue/${b.key}`), status: 500, times: 1 });
  const res = await ok('resolutionRepair', { items: [{ key: a.key, from: null, to: '10000' }, { key: b.key, from: null, to: '10000' }], runId: 'run000010' });
  assert.deepEqual(res.results.map((r) => r.status), ['repaired', 'failed']);
  assert.equal(b.resolution, null, 'a failed PUT is never retried blindly');
  void ctxProject;
});

test('Rovo: counts, examples and the workflow findings that cause them; non-admins get nothing', async () => {
  const { j } = seed();
  const res = await app.actResolutions({ projectKey: 'ALP' });
  assert.equal(res.doneButUnresolved, 2);
  assert.equal(res.openButResolved, 1);
  assert.equal(res.examplesDoneButUnresolved.length, 2);
  // wf-1 "Reject" (global → Done) sets no resolution: that is the cause
  assert.ok(res.causesInWorkflows.some((c) => c.transition === 'Reject'));
  j.perms.ADMINISTER = false;
  j.perms.projectAdmin.delete('100');
  const denied = await app.actResolutions({ projectKey: 'ALP' });
  assert.match(denied.error, /not available/);
});

test('clearing runs the workflow transition into the current status (live Jira rejects every edit); undo puts it back', async () => {
  const { j, S, c } = seed();
  const clear = await ok('resolutionRepair', { items: [{ key: c.key, from: '10000', to: null }], runId: 'run000020', kind: 'openResolved' });
  assert.equal(clear.results[0].status, 'repaired', JSON.stringify(clear.results[0]));
  assert.equal(clear.results[0].via, 'Reopen');
  assert.equal(c.resolution, null);
  assert.equal(c.statusId, S.open, 'status unchanged');
  assert.deepEqual(j.transitionsRun, [{ key: c.key, id: '61' }]);
  // Undo sets the resolution back (the edit API can set one)
  const undo = await ok('resolutionRepair', { items: [{ key: c.key, from: null, to: '10000' }], runId: 'undo000020', undoOf: 'run000020' });
  assert.equal(undo.results[0].status, 'repaired');
  assert.equal(c.resolution, '10000');
  assert.equal((await ok('resolutionRuns')).find((r) => r.id === 'run000020').undoneBy, 'undo000020');
});

test('no clearing transition for the status: a clear message, nothing changed; a failed undo keeps the run undoable', async () => {
  const { j, S, a, c } = seed();
  j.workflows.get('wf-1').transitions = j.workflows.get('wf-1').transitions.filter((t) => t.id !== '61');
  const res = await ok('resolutionRepair', { items: [{ key: c.key, from: '10000', to: null }], runId: 'run000030', kind: 'openResolved' });
  assert.equal(res.results[0].code, 'CANNOT_CLEAR');
  assert.equal(c.resolution, '10000');
  assert.equal(c.statusId, S.open);
  // A set-run whose undo fails stays undoable
  await ok('resolutionRepair', { items: [{ key: a.key, from: null, to: '10001' }], runId: 'run000031', kind: 'doneUnresolved' });
  const failed = await ok('resolutionRepair', { items: [{ key: a.key, from: '10001', to: null }], runId: 'undo000031', undoOf: 'run000031' });
  assert.equal(failed.results[0].status, 'failed');
  assert.equal((await ok('resolutionRuns')).find((r) => r.id === 'run000031').undoneBy, undefined);
});
