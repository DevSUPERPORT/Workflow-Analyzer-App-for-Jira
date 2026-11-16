/**
 * Unit tests of the Phase 2 analytics: persona simulation, access matrix, path finder, similarity and
 * comparison, governance and action plan, load insights, Mermaid export, remediation issues and stable finding
 * fingerprints.
 *
 * @file        tests/insights.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/shared/engine.js';
import { simulatePersona, accessMatrix, findPaths, similarity, similarPairs, compareWorkflows, governance, actionPlan, loadInsights, toMermaid, findingToIssue, personaFor, evalTree } from '../src/shared/insights.js';
import { makeProcurementBundle, IDS } from './fixtures/procurement.js';

const model = normalize(makeProcurementBundle());
const wf = model.workflows.find((w) => w.name === 'IDE: Bedarfsworkflow');
const bug = model.workflows.find((w) => w.name === 'IDE: Bug Workflow');
const tr = (name) => wf.transitions.find((x) => x.name === name);
const ref = (name) => wf.statuses.find((s) => s.name === name).ref;

test('persona simulation evaluates restrict conditions and AND/OR groups', () => {
  const proc = { ...personaFor({ type: 'group', id: IDS.G_PROC }) };
  const sim = simulatePersona(wf, proc);
  assert.equal(sim[tr('Freigeben').key].state, 'yes');
  assert.equal(sim[tr('GB prüfen').key].state, 'no');
  // GB OK = Procurement AND (recht OR reporter)
  assert.equal(sim[tr('GB OK').key].state, 'no');
  const procReporter = { ...proc, reporter: true };
  assert.equal(simulatePersona(wf, procReporter)[tr('GB OK').key].state, 'yes');
  // Unconditional transition
  assert.equal(sim[tr('Bestellen').key].state, 'yes');
  // Separation of duties depends on issue history
  assert.equal(sim[tr('Zur Geschäftsleitung').key].state, 'maybe');
  assert.equal(evalTree(tr('Bestellung abschließen').conditions, proc).v, null);
});

test('access matrix lists principals and cells', () => {
  const m = accessMatrix([wf]);
  const names = m.principals.map((p) => p.name || p.type);
  assert.ok(names.includes('Procurement'));
  assert.ok(names.includes('reporter'));
  assert.ok(names.includes('Administrators'));
  const row = m.rows.find((r) => r.t.name === 'GB prüfen');
  const iRecht = m.principals.findIndex((p) => p.name === 'recht');
  assert.equal(row.cells[iRecht], 'yes');
  assert.equal(row.everyone, 'no');
});

test('path finder returns shortest path and honours blocked transitions', () => {
  const paths = findPaths(wf, ref('Bedarfsanfrage stellen'), ref('GB-Kontrolle'));
  assert.ok(paths.length >= 1);
  assert.deepEqual(paths[0].map((s) => s.t.name), ['Zur Freigabe', 'Freigeben', 'Bestellen', 'Angebote einholen', 'GB erstellen', 'Zur GB-Kontrolle']);
  const blocked = new Set([tr('Freigeben').key]);
  assert.equal(findPaths(wf, ref('Bedarfsanfrage stellen'), ref('GB-Kontrolle'), { blocked }).length, 0);
  // global transition reaches "Nicht genehmigt" in one step
  assert.equal(findPaths(wf, ref('GB-Klärung'), ref('Nicht genehmigt'))[0].length, 1);
});

test('similarity and comparison', () => {
  assert.equal(similarity(wf, wf), 100);
  assert.ok(similarity(wf, bug) < 30);
  const b2 = makeProcurementBundle();
  const copy = JSON.parse(JSON.stringify(b2.workflows[0]));
  copy.id = 'copy';
  copy.name = 'IDE: Bedarfsworkflow (Kopie)';
  copy.transitions = copy.transitions.filter((t) => t.name !== 'Bestellen');
  b2.workflows.push(copy);
  const m2 = normalize(b2);
  const pairs = similarPairs(m2.workflows, 75);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].score >= 85 && pairs[0].score < 100);
  const cmp = compareWorkflows(m2.workflows.find((w) => w.id !== 'copy' && w.name.includes('Bedarf')), m2.workflows.find((w) => w.id === 'copy'));
  assert.deepEqual(cmp.transitionsOnlyA.map((t) => t.name), ['Bestellen']);
  assert.equal(cmp.transitionsOnlyB.length, 0);
});

test('governance categories and action plan', () => {
  const g = governance(model);
  assert.deepEqual(g.map((c) => c.key), ['structure', 'data', 'access', 'integrity', 'maintainability']);
  assert.ok(g.find((c) => c.key === 'integrity').score < g.find((c) => c.key === 'structure').score);
  const plan = actionPlan(model);
  assert.equal(plan[0].priority, 'P1');
  assert.ok(plan.find((p) => p.code === 'DONE_NO_RESOLUTION').findings.length === 2);
  assert.ok(!plan.some((p) => p.code === 'COMPLEX'), 'info findings are not actions');
});

test('load insights detect bottlenecks, stale and never used statuses', () => {
  const byStatus = {};
  for (const s of wf.statuses) byStatus[s.id] = { count: 1, stale: 0, ever: 1 };
  byStatus['10640'] = { count: 12, stale: 8, ever: 30 };
  byStatus['10999'] = { count: 0, stale: 0, ever: 0 };
  const ins = loadInsights(model, { byStatus, total: 30, staleDays: 30 });
  assert.ok(ins.find((i) => i.code === 'BOTTLENECK' && i.status === 'GB-Kontrolle'));
  assert.ok(ins.find((i) => i.code === 'STALE' && i.status === 'GB-Kontrolle'));
  assert.ok(ins.find((i) => i.code === 'NEVER_USED' && i.status === 'Archiv'));
});

test('mermaid export and remediation issue payload', () => {
  const m = toMermaid(bug);
  assert.match(m, /^stateDiagram-v2/);
  assert.match(m, /\[\*\] --> S0: Create/);
  const f = model.findings.find((x) => x.code === 'UNRESOLVED_REF');
  const issue = findingToIssue(f, 'de', { projectKey: 'IDE' });
  assert.match(issue.summary, /Kritisch/);
  assert.equal(issue.description.type, 'doc');
  assert.ok(issue.fingerprint.startsWith('UNRESOLVED_REF|'));
});

test('finding fingerprints survive Jira regenerating rule IDs (live finding)', async () => {
  const { findingFingerprint } = await import('../src/shared/insights.js');
  const f = { code: 'UNRESOLVED_REF', wfId: 'w', tKey: 'w::11', ruleKind: 'condition', ruleKey: 'system:restrict-issue-transition', ruleId: 'aaa', params: { id: 'g' } };
  assert.equal(findingFingerprint(f), findingFingerprint({ ...f, ruleId: 'bbb' }));
  assert.notEqual(findingFingerprint(f), findingFingerprint({ ...f, ruleKind: 'validator' }));
});
