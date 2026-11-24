/**
 * The monitoring hash must ignore the order in which Jira returns workflows, issue types, source statuses and
 * rules – otherwise users saw "The workflows changed … (0 differences)".
 *
 * @file        tests/snapshot-hash.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-24
 * @updated     2026-11-24
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/shared/engine.js';
import { makeSnapshot, snapshotHash, diffSnapshots } from '../src/shared/snapshot.js';
import { makeProcurementBundle } from './fixtures/procurement.js';

const snap = makeSnapshot(normalize(makeProcurementBundle()));

test('reordered lists give the same hash and no differences', () => {
  const shuffled = structuredClone(snap);
  shuffled.workflows.reverse();
  for (const w of shuffled.workflows) {
    w.it.reverse();
    w.s.reverse();
    w.t.reverse();
    for (const t of w.t) { t.f.reverse(); t.r.reverse(); }
  }
  assert.deepEqual(diffSnapshots(snap, shuffled), []);
  assert.equal(snapshotHash(shuffled), snapshotHash(snap));
});

test('a real change still changes the hash', () => {
  const changed = structuredClone(snap);
  changed.workflows[0].t[0].n = 'Renamed';
  assert.notEqual(snapshotHash(changed), snapshotHash(snap));
  assert.equal(diffSnapshots(snap, changed).length, 1);
});
