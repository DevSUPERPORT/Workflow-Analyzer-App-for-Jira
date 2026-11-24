/**
 * Diagram labels: a transition label never covers a status box or another label (tester report 2026-11-23: the label
 * "Zur GB-Kontrolle" covered the status "Done"), in Jira's layout and in the automatic one.
 *
 * @file        tests/diagram-labels.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-24
 * @updated     2026-11-24
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutWorkflow } from '../src/shared/diagram.js';
import { normalize } from '../src/shared/engine.js';
import { compareWorkflows } from '../src/shared/insights.js';
import { makeProcurementBundle } from './fixtures/procurement.js';

function overlaps(l) {
  const boxes = [...l.nodes, ...l.virtual];
  const out = [];
  for (const e of l.edges) {
    const a = e.label;
    for (const b of boxes) if (a.x + a.w / 2 > b.x && a.x - a.w / 2 < b.x + b.w && a.y + 9 > b.y && a.y - 9 < b.y + b.h) out.push(`${a.text} on ${b.name || b.ref}`);
  }
  return out;
}

test('no transition label covers a status box, in both layouts', () => {
  const model = normalize(makeProcurementBundle());
  for (const wf of model.workflows) for (const mode of ['jira', 'auto']) {
    const l = layoutWorkflow(wf, { mode });
    assert.deepEqual(overlaps(l), [], `${wf.name} (${mode})`);
  }
});

test('Jira layout with statuses placed close together: labels move off the boxes', () => {
  const model = normalize(makeProcurementBundle());
  const wf = model.workflows.find((w) => w.statuses.length > 5);
  // squeeze every status onto a tight grid, like a crowded Jira layout
  wf.statuses.forEach((s, i) => { s.x = (i % 4) * 150; s.y = Math.floor(i / 4) * 70; });
  const l = layoutWorkflow(wf, { mode: 'jira' });
  assert.equal(l.mode, 'jira');
  assert.deepEqual(overlaps(l), []);
});

test('Compare: workflows with one different rule are not called identical', () => {
  const model = normalize(makeProcurementBundle());
  const a = model.workflows[0];
  const b = structuredClone(a);
  b.id = 'copy';
  const same = compareWorkflows(a, b);
  assert.equal(same.transitionsChanged.length + same.transitionsOnlyA.length + same.transitionsOnlyB.length, 0, 'a copy has no differences');
  b.transitions = b.transitions.slice(1);
  const diff = compareWorkflows(a, b);
  assert.ok(diff.transitionsOnlyA.length > 0, 'one transition missing is a difference');
});
