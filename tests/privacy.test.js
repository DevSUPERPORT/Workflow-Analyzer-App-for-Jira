/**
 * Tests of Atlassian's personal data requirements (src/lib/privacy.js, src/lib/names.js): the app stores account IDs
 * only (names are looked up when shown), reports stored account IDs at most weekly, erases closed accounts, removes
 * display names stored by older versions once, and pauses while the kill switch is on.
 *
 * @file        tests/privacy.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, app, scenario, ctxSite, ok, normalize } from './support/harness.js';
import { findingFingerprint } from '../src/shared/insights.js';
const { clearNameCache } = await import('../src/lib/names.js');

const ME = 'user-admin';
const NAME = 'Dana Admin';
const dump = () => JSON.stringify([...state.kvs.entries()]);

function setup() {
  const ctx = scenario();
  ctx.j.users.push({ accountId: ME, displayName: NAME, active: true });
  ctx.j.me = { accountId: ME, displayName: NAME };
  state.privacyReports = [];
  state.privacyClosed = new Set();
  clearNameCache();
  return ctx;
}

afterEach(() => { delete process.env.APP_MAINTENANCE; });

async function useTheApp() {
  const { bundle } = await ok('getProjectData', {});
  const model = normalize(bundle);
  const target = model.findings.find((f) => f.code === 'DONE_NO_RESOLUTION' && f.wfId === 'wf-1');
  const plan = await ok('autofixPlan', { workflowId: 'wf-1', fingerprints: [findingFingerprint(target)], lang: 'en' });
  await ok('applyPlan', { id: plan.id });
  await ok('rollbackPlan', { id: plan.id });
  await ok('saveNote', { workflowId: 'wf-1', transitionId: '11', text: 'Ask legal first' });
  await ok('saveSnapshot', { label: 'before release' });
  await ok('setAiSettings', { enabled: false }, ctxSite());
  await ok('setPrefs', { lang: 'de' });
  await ok('setMonitoring', { enabled: true });
  return plan;
}

test('the app stores account IDs only; names are looked up when the data is shown', async () => {
  setup();
  const plan = await useTheApp();
  assert.ok(!dump().includes(NAME), 'no display name anywhere in storage');
  const stored = state.kvs.get(`plan-${plan.id}`);
  assert.equal(stored.createdBy, ME);
  assert.equal(stored.appliedById, ME);
  assert.equal(stored.rolledBackById, ME);

  assert.equal((await ok('listPlans', {}))[0].createdByName, NAME);
  assert.equal((await ok('getPlan', { id: plan.id })).createdByName, NAME);
  assert.equal((await ok('getNotes', { workflowIds: ['wf-1'] }))['wf-1']['11'].byName, NAME);
  assert.equal((await ok('getProjectData', {})).notes['wf-1']['11'].byName, NAME);
  const snaps = await ok('listSnapshots', {});
  assert.equal(snaps.find((s) => s.label === 'before release').by, NAME);
  assert.ok(snaps.some((s) => /^Autopilot: before/.test(s.label) && s.by === NAME), 'the Autopilot safety snapshot names who applied');
  assert.equal((await ok('getAiSettings', {}, ctxSite())).updatedByName, NAME);
  assert.ok(!dump().includes(NAME), 'showing names stores nothing');
});

test('every place that stores an account ID registers it, and the report reads only the registry', async () => {
  setup();
  await useTheApp();
  assert.deepEqual(state.kvs.get('acct-user-admin')?.id, ME);
  // data of an account that is only in records, not in the registry, is not scanned for: the registry is the source
  state.kvs.set('acct-712020:other', { id: '712020:other', at: '2026-11-01T00:00:00.000Z' });
  await app.privacy();
  assert.deepEqual(state.privacyReports[0].map((a) => a.accountId).sort(), ['712020:other', ME].sort());
  assert.equal(state.privacyReports[0].find((a) => a.accountId === '712020:other').updatedAt, '2026-11-01T00:00:00.000Z');
});

test('erasing runs within a time budget and continues the next day', async () => {
  setup();
  await useTheApp();
  const { reportPersonalData } = await import('../src/lib/privacy.js');
  await reportPersonalData({ report: async () => [] }); // migration and a first report
  state.kvs.delete('privacy-last-report');
  const closed = async (accounts) => accounts.map((a) => ({ accountId: a.accountId, status: 'closed' }));
  const late = await reportPersonalData({ report: closed, deadline: Date.now() - 1 });
  assert.equal(late.unfinished, true);
  assert.equal(state.kvs.has('privacy-last-report'), false, 'not marked as reported');
  assert.ok(state.kvs.has('acct-user-admin'), 'the account stays registered, so it is reported (and erased) again');
  const next = await reportPersonalData({ report: closed });
  assert.equal(next.erased, 1);
  assert.ok(!dump().includes(ME));
});

test('the one-time migration is resumable', async () => {
  setup();
  state.kvs.set('notes-wf-1', { 11: { text: 'keep', by: ME, byName: NAME, at: '2026-11-01T00:00:00Z' } });
  state.kvs.set('pref-712020:zz', { lang: 'de', updatedAt: '2026-10-01T00:00:00Z' });
  const { migrate } = await import('../src/lib/privacy.js');
  assert.equal(await migrate({ deadline: Date.now() - 1 }), false, 'out of time after the first page');
  let rounds = 1;
  while (!(await migrate({ deadline: Date.now() - 1 }))) rounds++;
  assert.ok(rounds > 1);
  assert.equal(state.kvs.get('acct-user-admin').id, ME);
  assert.equal(state.kvs.get('acct-712020:zz').at, '2026-10-01T00:00:00.000Z');
  assert.ok(!dump().includes(NAME));
});

test('a renamed account shows its current name', async () => {
  const { j } = setup();
  await ok('saveNote', { workflowId: 'wf-1', transitionId: '11', text: 'x' });
  j.users.find((u) => u.accountId === ME).displayName = 'Dana Renamed';
  clearNameCache();
  assert.equal((await ok('getNotes', { workflowIds: ['wf-1'] }))['wf-1']['11'].byName, 'Dana Renamed');
});

test('stored account IDs are reported to Atlassian at most once a week', async () => {
  setup();
  await useTheApp();
  await app.privacy();
  assert.equal(state.privacyReports.length, 1);
  const reported = state.privacyReports[0];
  assert.deepEqual(reported.map((a) => a.accountId), [ME]);
  assert.ok(!Number.isNaN(Date.parse(reported[0].updatedAt)));
  await app.privacy();
  assert.equal(state.privacyReports.length, 1, 'not again within 7 days');
  state.kvs.set('privacy-last-report', new Date(Date.now() - 5 * 86400000).toISOString());
  await app.privacy();
  assert.equal(state.privacyReports.length, 1, 'not after 5 days');
  state.kvs.set('privacy-last-report', new Date(Date.now() - 6 * 86400000 - 60000).toISOString());
  await app.privacy();
  assert.equal(state.privacyReports.length, 2, 'again after 6 days, so a daily trigger never exceeds 7');
});

test('a closed account is erased: its own entries deleted, its ID removed from every record, the content kept', async () => {
  setup();
  const plan = await useTheApp();
  state.privacyClosed.add(ME);
  await app.privacy();
  const all = dump();
  assert.ok(!all.includes(ME), 'the account ID is gone from storage');
  assert.equal([...state.kvs.keys()].some((k) => k.startsWith('pref-') || k.startsWith('seen')), false, 'preferences and visit markers deleted');
  assert.equal(state.kvs.get(`plan-${plan.id}`).status, 'rolledback', 'the plan stays');
  assert.equal(state.kvs.get('notes-wf-1')['11'].text, 'Ask legal first', 'the team note stays');
  assert.equal(state.kvs.get('ai-settings').aiEnabled, false, 'the AI switch stays');
  assert.equal((await ok('getNotes', { workflowIds: ['wf-1'] }))['wf-1']['11'].byName, null);
});

test('display names stored by older versions are removed once', async () => {
  setup();
  const legacy = {
    'plan-p1': { id: 'p1', projectId: '100', status: 'applied', createdAt: '2026-11-01T00:00:00Z', createdBy: ME, createdByName: NAME, appliedBy: NAME, rolledBackBy: NAME, ops: [] },
    'plans-100': [{ id: 'p1', status: 'applied', createdAt: '2026-11-01T00:00:00Z', createdByName: NAME }],
    'bulk-b1': { id: 'b1', createdBy: ME, createdByName: NAME, children: [] },
    bulkidx: [{ id: 'b1', createdByName: NAME }],
    'snapidx-100': [{ id: 's1', by: NAME, label: 'mine', chunks: 1 }, { id: 's2', by: 'Workflow Analyzer (auto)', label: 'auto', chunks: 1 }],
    'snap-100-s1-0': JSON.stringify({ v: 1, by: NAME, label: 'mine', workflows: [] }),
    'snap-100-s2-0': JSON.stringify({ v: 1, by: 'Workflow Analyzer (auto)', label: 'auto', workflows: [] }),
    'notes-wf-1': { 11: { text: 'keep me', by: ME, byName: NAME, at: '2026-11-01T00:00:00Z' } },
    'rem-100': { abc: { key: 'ALP-1', at: '2026-11-01T00:00:00Z', by: NAME } },
    'monitor-projects': [{ id: '100', key: 'ALP', since: '2026-11-01T00:00:00Z', by: NAME }],
    'resfix-ALP': [{ id: 'r1', at: '2026-11-01T00:00:00Z', by: NAME, items: [] }],
    'ai-settings': { aiEnabled: true, updatedBy: ME, updatedByName: NAME, history: [{ aiEnabled: true, by: ME, byName: NAME }] },
  };
  for (const [k, v] of Object.entries(legacy)) state.kvs.set(k, v);
  await app.privacy();
  assert.ok(!dump().includes(NAME), 'no stored display name left');
  assert.equal(state.kvs.get('plans-100')[0].createdBy, ME, 'the index learns the author ID from the plan');
  assert.equal(state.kvs.get('bulkidx')[0].createdBy, ME);
  assert.equal(state.kvs.get('snapidx-100')[1].by, 'Workflow Analyzer (auto)', 'system labels stay');
  assert.equal(JSON.parse(state.kvs.get('snap-100-s1-0')).by, null);
  assert.equal(state.kvs.get('notes-wf-1')['11'].text, 'keep me');
  // the account IDs are still reported, and names come from Jira again
  assert.deepEqual(state.privacyReports[0].map((a) => a.accountId), [ME]);
  assert.equal((await ok('listPlans', {}))[0].createdByName, NAME);
  // runs once
  state.kvs.set('notes-wf-1', { 11: { text: 'x', by: ME, byName: 'Later' } });
  state.kvs.set('privacy-last-report', new Date(0).toISOString());
  await app.privacy();
  assert.equal(state.kvs.get('notes-wf-1')['11'].byName, 'Later', 'the clean-up does not run twice');
});

test('the privacy job pauses while the kill switch is on or read-only, and runs on unlicensed sites', async () => {
  setup();
  await ok('setPrefs', { lang: 'de' });
  for (const mode of ['on', 'readonly']) {
    process.env.APP_MAINTENANCE = mode;
    await app.privacy();
    assert.equal(state.privacyReports.length, 0, mode);
  }
  delete process.env.APP_MAINTENANCE;
  await app.privacy();
  assert.equal(state.privacyReports.length, 1);
});

test('manifest: a daily privacy trigger that is not limited to licensed sites', async () => {
  const fs = await import('node:fs');
  const m = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const block = /- key: personal-data-daily\r?\n\s+function: privacy\r?\n\s+interval: day\r?\n(?!\s+filter)/.test(m);
  assert.ok(block, 'personal-data-daily runs daily without an appIsLicensed filter');
  assert.match(m, /- key: privacy\r?\n\s+handler: index\.privacy/);
});
