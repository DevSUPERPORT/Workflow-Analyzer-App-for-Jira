// Transitions tab filter count: counts transitions, not rows (a transition with several source statuses has one row
// per source). Regression for "2 of 22 transitions shown" while the tab badge said 21 (2026-11-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTransitions } from '../static/app/src/lib/transitionCount.js';

const tr = (key, name) => ({ key, name });
const a = tr('wf1|11', 'Start');
const b = tr('wf1|21', 'Freigeben'); // two source statuses -> two rows
const c = tr('wf2|21', 'Freigeben');
const sections = [
  { rows: [{ tr: a }] },
  { rows: [{ tr: b }] },
  { rows: [{ tr: b }, { tr: c }] },
];

test('counts each transition once, even with several source rows', () => {
  assert.equal(countTransitions(sections), 3);
});

test('counts visible transitions once', () => {
  assert.equal(countTransitions(sections, (x) => x.name === 'Freigeben'), 2);
  assert.equal(countTransitions(sections, () => false), 0);
});

test('empty sections give 0', () => {
  assert.equal(countTransitions([]), 0);
});
