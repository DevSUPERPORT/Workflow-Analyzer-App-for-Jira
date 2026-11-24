/**
 * Tests of the Marketplace licence gate (paid via Atlassian): on a site whose licence is not active every resolver
 * and Rovo action is refused before Jira, the storage or the AI is touched; `availability` tells the UI so it can
 * show the licence notice; installs without a license object (development) and active licences work as before.
 *
 * @file        tests/license.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { state, app, scenario, ctxProject, ctxSite, call, ok } from './support/harness.js';
import { isLicenseInactive } from '../src/lib/license.js';

const INACTIVE_EN = 'The Workflow Analyzer & Optimizer for Jira licence for this site is not active. A Jira administrator can start a free trial or subscribe under Apps › Manage your apps. Your saved data is kept.';
const unlicensed = (ctx) => ({ ...ctx, license: { active: false, isActive: false } });
const licensed = (ctx) => ({ ...ctx, license: { active: true, isActive: true } });

test('isLicenseInactive: only an explicit false counts; no license object (development) is not inactive', () => {
  assert.equal(isLicenseInactive(undefined), false);
  assert.equal(isLicenseInactive(null), false);
  assert.equal(isLicenseInactive({ active: true }), false);
  assert.equal(isLicenseInactive({ isActive: true }), false);
  assert.equal(isLicenseInactive({ active: false }), true);
  assert.equal(isLicenseInactive({ isActive: false }), true);
  assert.equal(isLicenseInactive({ active: true, isActive: false }), true);
});

test('unlicensed site: every resolver is refused with LICENSE_INACTIVE before Jira or storage is touched', async () => {
  const { j } = scenario();
  const before = JSON.stringify([...state.kvs.entries()]);
  const logBefore = j.log.length;
  const llmBefore = state.llm.length;
  for (const name of Object.keys(app.handler).filter((n) => n !== 'availability')) {
    const ctx = /^site|resolution|Ai|AiSettings/.test(name) ? ctxSite() : ctxProject();
    const res = await call(name, {}, unlicensed(ctx));
    assert.equal(res.ok, false, name);
    assert.equal(res.error, 'LICENSE_INACTIVE', name);
    assert.equal(res.message, INACTIVE_EN, name);
  }
  assert.equal(j.log.length, logBefore, 'no Jira call');
  assert.equal(JSON.stringify([...state.kvs.entries()]), before, 'nothing stored');
  assert.equal(state.llm.length, llmBefore, 'no AI call');
  const de = await call('bootstrap', { lang: 'de' }, unlicensed(ctxProject()));
  assert.match(de.message, /Lizenz von Workflow Analyzer & Optimizer for Jira ist für diese Site nicht aktiv/);
});

test('availability reports the licence so the UI shows the notice first', async () => {
  scenario();
  assert.equal((await ok('availability', {}, unlicensed(ctxProject()))).licensed, false);
  assert.equal((await ok('availability', {}, licensed(ctxProject()))).licensed, true);
  assert.equal((await ok('availability', {}, ctxProject())).licensed, true, 'no license object: licensed');
});

test('Rovo actions answer with the licence text on an unlicensed site', async () => {
  scenario();
  const res = await app.actOverview({ projectKey: 'ALP' }, { license: { active: false } });
  assert.deepEqual(res, { error: INACTIVE_EN });
});

test('active licence and development installs work as before', async () => {
  scenario();
  assert.equal((await ok('bootstrap', {}, licensed(ctxProject()))).allowed, true);
  assert.equal((await ok('bootstrap', {}, ctxProject())).allowed, true);
});

test('manifest: licensing on, the daily monitor runs only on licensed sites', () => {
  const m = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  assert.match(m, /^\s{2}licensing:\s*\n\s{4}enabled: true/m);
  assert.match(m, /key: workflow-monitor-daily[\s\S]{0,120}filter:\s*\n\s+appIsLicensed: true/);
});
