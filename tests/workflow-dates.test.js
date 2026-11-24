/**
 * The Overview's "Last changed" column: Jira's bulk workflow request has no change dates, so the app takes them from
 * the workflow search (project page: one search per workflow; site-wide scan: from the search page itself).
 *
 * @file        tests/workflow-dates.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-24
 * @updated     2026-11-24
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenario, ok, ctxSite, normalize } from './support/harness.js';

test('project page: every workflow has its last-changed date from the workflow search', async () => {
  scenario();
  const { bundle } = await ok('getProjectData', {});
  assert.ok(bundle.workflows.length >= 2);
  for (const wf of bundle.workflows) assert.equal(wf.updated, '2026-11-20T14:30:00.000+0000', wf.name);
  const model = normalize(bundle);
  for (const wf of model.workflows) assert.equal(wf.updated, '2026-11-20T14:30:00.000+0000', `model ${wf.name}`);
});

test('site-wide scan: the dates come from the search page, no extra request', async () => {
  const { j } = scenario();
  const page = await ok('siteScanPage', { startAt: 0 }, ctxSite());
  assert.ok(page.workflows.length > 0);
  for (const wf of page.workflows) assert.equal(wf.updated, '2026-11-20T14:30:00.000+0000', wf.name);
  assert.equal(j.log.filter((l) => /workflows\/search\?queryString/.test(l)).length, 0);
});
