/**
 * Unit tests of the Autopilot engine: operation catalogue and JSON schema, applying operations, per-operation
 * errors, dry run and auto-fix, status removal migrations and the shape of the Jira bulk update payload,
 * including findings verified live on superportdev.
 *
 * @file        tests/autopilot.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/shared/engine.js';
import { applyOperations, dryRun, buildUpdatePayload, autofixOperations, OPS, OPS_JSON_SCHEMA } from '../src/shared/autopilot.js';
import { makeProcurementBundle, IDS } from './fixtures/procurement.js';

const bundle = makeProcurementBundle();
const WF = bundle.workflows[0];
const ctx = { statuses: bundle.statuses, ref: bundle.ref, resolutions: bundle.ref.resolutions };

test('operation catalogue and JSON schema are consistent', () => {
  assert.deepEqual(OPS_JSON_SCHEMA.properties.operations.items.properties.op.enum, Object.keys(OPS));
});

test('add status + transitions, restrict and require fields', () => {
  const ops = [
    { op: 'addStatus', name: 'Eskaliert', category: 'IN_PROGRESS' },
    { op: 'addTransition', name: 'Eskalieren', from: ['GB-Kontrolle', 'GB-Klärung'], to: 'Eskaliert' },
    { op: 'addTransition', name: 'Zurück zur Kontrolle', from: 'Eskaliert', to: 'GB-Kontrolle' },
    { op: 'restrictTransition', transition: 'Eskalieren', groups: ['Procurement'], reporter: true },
    { op: 'requireFields', transition: 'Eskalieren', fields: ['Warengruppe'], message: 'Warengruppe fehlt' },
  ];
  const r = applyOperations(WF, ops, ctx);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  assert.equal(r.newStatuses.length, 1);
  const t = r.workflow.transitions.find((x) => x.name === 'Eskalieren');
  assert.equal(t.links.length, 2);
  assert.equal(t.conditions.conditions[0].parameters.groupIds, IDS.G_PROC);
  assert.equal(t.conditions.conditions[0].parameters.accountIds, 'allow-reporter');
  assert.equal(t.validators[0].parameters.fieldsRequired, 'customfield_11420');
  assert.notEqual(t.id, '1');
  // original untouched
  assert.ok(!WF.transitions.some((x) => x.name === 'Eskalieren'));
});

test('errors are reported per operation without aborting the plan', () => {
  const r = applyOperations(WF, [
    { op: 'renameTransition', transition: 'Bestellen', newName: 'Bestellung auslösen' },
    { op: 'addTransition', name: 'X', to: 'Gibt es nicht' },
    { op: 'restrictTransition', transition: 'Bestellen', groups: ['unbekannte-gruppe'] },
    { op: 'bogus' },
  ], ctx);
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, false, false]);
  assert.match(r.results[1].message, /not found/);
  assert.ok(r.workflow.transitions.some((x) => x.name === 'Bestellung auslösen'));
});

test('dry run shows diff and health impact; auto-fix resolves findings', () => {
  const model = normalize(bundle);
  const wfId = WF.id;
  const { ops, manual } = autofixOperations(model, model.findings.filter((f) => f.wfId === wfId), bundle.ref.resolutions);
  assert.ok(ops.find((o) => o.op === 'setResolution' && o.resolution === 'Done'));
  assert.ok(ops.find((o) => o.op === 'removeReference' && o.ref === IDS.G_DELETED));
  assert.ok(ops.find((o) => o.op === 'removeReference' && o.refType === 'user' && o.ref === IDS.U_BERNAR));
  assert.ok(ops.find((o) => o.op === 'removeRule'));
  assert.ok(manual.some((f) => f.code === 'UNREACHABLE'));
  const dr = dryRun(bundle, wfId, ops);
  assert.ok(dr.results.every((x) => x.ok), JSON.stringify(dr.results.filter((x) => !x.ok)));
  assert.ok(dr.healthAfter > dr.healthBefore, `${dr.healthBefore} -> ${dr.healthAfter}`);
  assert.ok(dr.fixed.some((f) => f.code === 'UNRESOLVED_REF'));
  assert.ok(dr.fixed.some((f) => f.code === 'DONE_NO_RESOLUTION'));
  assert.ok(dr.changes.some((c) => c.type === 'rule' && c.op === 'added'));
  // JMWE (app) reference to the inactive user cannot be fixed automatically
  assert.ok(manual.some((f) => f.code === 'INACTIVE_USER' && f.vendor === 'JMWE'));
});

test('remove status moves issues and drops its transitions', () => {
  const r = applyOperations(WF, [{ op: 'removeStatus', status: 'Archiv', moveIssuesTo: 'Nicht genehmigt' }], ctx);
  assert.ok(r.results[0].ok);
  assert.ok(!r.workflow.statuses.some((s) => s.statusReference === 'ref-10999'));
  assert.deepEqual(r.statusMappings, [{ oldStatusReference: '10999', newStatusReference: '10301' }]);
});

test('update payload has the shape of the Jira bulk update API', () => {
  const r = applyOperations(WF, [{ op: 'addStatus', name: 'Neu' }, { op: 'setTransitionScreen', transition: 'GB OK', screen: 'GB Prüfmaske' }], ctx);
  const p = buildUpdatePayload({ ...r.workflow, version: { id: 'v1', versionNumber: 42 } }, { siteStatuses: bundle.statuses, newStatuses: r.newStatuses });
  assert.equal(p.workflows[0].id, WF.id);
  assert.equal(p.workflows[0].version.versionNumber, 42);
  assert.equal(p.statuses.length, WF.statuses.length + 1);
  assert.ok(p.statuses.every((s) => s.name && s.statusCategory && s.statusReference));
  assert.ok(p.statuses.filter((s) => !s.id).length === 1, 'only the new status has no id');
  const gb = p.workflows[0].transitions.find((x) => x.name === 'GB OK');
  assert.equal(gb.transitionScreen.parameters.screenId, '10050');
  assert.equal(gb.conditions.conditionGroups[0].operation, 'ANY');
});

test('real Jira payload (WFAT on superportdev): no conditions on initial transition, empty groups omitted', async () => {
  const fs = await import('node:fs');
  const live = JSON.parse(fs.readFileSync(new URL('./fixtures/wfat-live.json', import.meta.url)));
  const r = applyOperations(live.workflow, [{ op: 'addTransition', name: 'Zur Freigabe', from: ['Backlog'], to: 'Done' }, { op: 'restrictTransition', transition: 'Zur Freigabe', groups: ['wfa-test-legal'] }], { statuses: live.statuses, ref: live.ref, resolutions: live.ref.resolutions });
  assert.ok(r.results.every((x) => x.ok));
  const p = buildUpdatePayload(r.workflow, { siteStatuses: live.statuses });
  const init = p.workflows[0].transitions.find((t) => t.type === 'INITIAL');
  assert.equal(init.conditions, undefined);
  assert.equal(p.workflows[0].transitions.find((t) => t.name === 'Backlog').conditions, undefined);
  assert.equal(p.workflows[0].transitions.find((t) => t.name === 'Zur Freigabe').conditions.conditions[0].parameters.groupIds, 'f5559baa-4c10-465e-8419-10e8ab8a21e2');
  // the live payload analyses without errors (transitions without "conditions" key)
  const m = normalize({ workflows: [live.workflow], statuses: live.statuses, ref: live.ref });
  assert.equal(m.workflows[0].transitions.length, 5);
  assert.ok(m.findings.some((f) => f.code === 'GLOBAL_UNGUARDED'));
});

test('LLM-style field aliases are normalised (live finding)', () => {
  const r = applyOperations(WF, [
    { op: 'addStatus', status: 'Eskaliert', category: 'IN_PROGRESS' },
    { op: 'addTransition', transition: 'Eskalieren', fromStatus: 'GB-Kontrolle', toStatus: 'Eskaliert' },
    { op: 'restrictTransition', name: 'Eskalieren', group: 'Procurement' },
    { op: 'addTransition', name: 'Deeskalieren', from: ['Eskaliert'], target: 'GB-Kontrolle' },
  ], ctx);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, true], JSON.stringify(r.results));
});

test('rollback/remove status produces migrations for removed statuses (live finding)', async () => {
  const { removedStatusMigrations } = await import('../src/shared/autopilot.js');
  const r = applyOperations(WF, [{ op: 'addStatus', name: 'Eskaliert' }, { op: 'addTransition', name: 'Eskalieren', from: ['GB-Kontrolle'], to: 'Eskaliert' }], ctx);
  const added = r.newStatuses[0].statusReference;
  const m = removedStatusMigrations(r.workflow, WF);
  assert.deepEqual(m, [{ oldStatusReference: added, newStatusReference: 'ref-10640' }]);
  const p = buildUpdatePayload(WF, { siteStatuses: bundle.statuses, statusMappings: m, projectStatusMappings: [{ projectId: '10100', issueTypeId: '10001', statusMigrations: m }] });
  assert.equal(p.workflows[0].statusMappings[0].projectId, '10100');
});

test('status removal payload keeps the removed status listed and maps it per project/issue type (verified live)', () => {
  const live = { statuses: [...bundle.statuses] };
  const r = applyOperations(WF, [{ op: 'removeStatus', status: 'Archiv', moveIssuesTo: 'Nicht genehmigt' }], ctx);
  const psm = [{ projectId: '10100', issueTypeId: '10001', statusMigrations: r.statusMappings }];
  const p = buildUpdatePayload(r.workflow, { siteStatuses: live.statuses, statusMappings: r.statusMappings, projectStatusMappings: psm });
  assert.ok(p.statuses.some((s) => s.id === '10999'), 'removed status stays in the top-level list');
  assert.ok(!p.workflows[0].statuses.some((s) => s.statusReference === 'ref-10999'), 'but not in the workflow layout');
  assert.equal(p.workflows[0].defaultStatusMappings, undefined);
  assert.deepEqual(p.workflows[0].statusMappings, psm);
});

test('team-managed workflows: no resolution findings, setResolution refused (live finding on KAN)', () => {
  const b = makeProcurementBundle();
  b.workflows[0].scope = { type: 'PROJECT', project: { id: '10100' } };
  const m = normalize(b);
  const wfId = b.workflows[0].id;
  assert.equal(m.findings.filter((f) => f.wfId === wfId && /RESOLUTION/.test(f.code)).length, 0);
  const r = applyOperations(b.workflows[0], [{ op: 'setResolution', transition: 'Ablehnen', resolution: 'Done' }], { statuses: b.statuses, ref: b.ref, resolutions: b.ref.resolutions });
  assert.equal(r.results[0].noop, true);
  assert.match(r.results[0].message, /Team-managed/);
  // company-managed keeps the check
  assert.ok(normalize(makeProcurementBundle()).findings.some((f) => f.code === 'DONE_NO_RESOLUTION'));
});
