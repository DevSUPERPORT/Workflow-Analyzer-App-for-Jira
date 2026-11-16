/**
 * Tests that the Custom UI shows no AI entry point while AI is effectively off: the effective flag (site switch on
 * AND not stopped by the vendor; off by default, on errors and for anything but a real true), the bootstrap data it
 * is derived from, the guide and tour variants without AI, and a source check that every AI entry point in the UI
 * is guarded by the effective flag (hidden, not greyed out) and that the old "AI is off" notice is gone.
 *
 * @file        tests/ai-ui-gating.test.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, ok, scenario, ctxSite } from './support/harness.js';
import { effectiveAi, isAiOn, fetchEffectiveAi, AI_OFF } from '../static/app/src/lib/aiState.js';
import { GUIDE, guideFor } from '../static/app/src/lib/guide-content.js';
import { t } from '../src/shared/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'static', 'app', 'src');
const setBudget = (v) => { if (v === undefined) delete process.env.AI_BUDGET; else process.env.AI_BUDGET = JSON.stringify(v); };
afterEach(() => setBudget(undefined));

// Words that invite using AI (EN and DE) – must not appear in texts shown while AI is off
const AI_WORDS = /\bAI\b|\bKI\b|KI-|Rovo|Copilot|in your own words|in eigenen Worten/;

// ---------------------------------------------------------------- effective flag

test('effective AI flag: off by default and for anything but enabled === true without a vendor stop', () => {
  for (const boot of [undefined, null, {}, { ai: null }, { ai: {} }, { ai: { enabled: false } }, { ai: { enabled: 'true' } }, { ai: { enabled: 1 } }, 'x', 42, new Error('boom')]) {
    assert.deepEqual(effectiveAi(boot), AI_OFF, JSON.stringify(boot) ?? String(boot));
  }
  assert.deepEqual(effectiveAi({ ai: { enabled: true, stopped: false } }), { enabled: true, stopped: false });
  assert.deepEqual(effectiveAi({ ai: { enabled: true } }), { enabled: true, stopped: false });
  // vendor stop wins over the site switch, even if a (buggy) server still says enabled
  assert.deepEqual(effectiveAi({ ai: { enabled: true, stopped: true } }), { enabled: false, stopped: true });
  assert.deepEqual(effectiveAi({ ai: { enabled: false, stopped: true } }), { enabled: false, stopped: true });

  assert.equal(isAiOn(undefined), false, 'static export render has no ai in its context');
  assert.equal(isAiOn({}), false);
  assert.equal(isAiOn({ enabled: 'yes' }), false);
  assert.equal(isAiOn({ enabled: true, stopped: true }), false);
  assert.equal(isAiOn({ enabled: true, stopped: false }), true);
});

test('re-checking the flag: an error or a refusal counts as off', async () => {
  assert.deepEqual(await fetchEffectiveAi(async () => { throw new Error('network'); }), AI_OFF);
  assert.deepEqual(await fetchEffectiveAi(() => Promise.reject(Object.assign(new Error('x'), { code: 'UNAVAILABLE' }))), AI_OFF);
  assert.deepEqual(await fetchEffectiveAi(async () => undefined), AI_OFF);
  assert.deepEqual(await fetchEffectiveAi(async () => ({ ai: { enabled: true, stopped: false } })), { enabled: true, stopped: false });
  assert.deepEqual(await fetchEffectiveAi(async () => ({ ai: { enabled: true, stopped: true } })), { enabled: false, stopped: true });
});

test('from real bootstrap data: off by default, on when a Jira admin enables it, off again while the vendor stops it', async () => {
  scenario();
  state.kvs.delete('ai-settings');
  assert.equal(effectiveAi(await ok('bootstrap')).enabled, false, 'default: off');
  assert.equal(effectiveAi(await ok('bootstrap', {}, ctxSite())).enabled, false, 'default: off on the site page too');

  await ok('setAiSettings', { enabled: true }, ctxSite());
  assert.deepEqual(effectiveAi(await ok('bootstrap')), { enabled: true, stopped: false }, 'switched on');

  for (const budget of [{ stop: true }, { callsPerMonth: 0 }, { tokensPerMonth: 0 }]) {
    setBudget(budget);
    assert.deepEqual(effectiveAi(await ok('bootstrap')), { enabled: false, stopped: true }, JSON.stringify(budget));
  }
  setBudget(undefined);
  assert.equal(effectiveAi(await ok('bootstrap')).enabled, true, 'the site setting is kept through a vendor stop');

  await ok('setAiSettings', { enabled: false }, ctxSite());
  assert.equal(effectiveAi(await ok('bootstrap')).enabled, false, 'switched off');
});

// ---------------------------------------------------------------- texts without AI

test('guide without AI: no AI chapter and no text that invites using AI; with AI everything is there', () => {
  for (const lang of ['en', 'de']) {
    const off = guideFor(lang, false);
    assert.ok(!off.chapters.some((c) => c.id === 'ai'), `${lang}: AI chapter hidden`);
    assert.ok(off.chapters.some((c) => c.id === 'autopilot'), `${lang}: Autopilot chapter kept`);
    assert.equal(off.golden.rules.length, GUIDE[lang].golden.rules.length, `${lang}: every golden rule kept`);
    assert.notDeepEqual(off.golden.rules, GUIDE[lang].golden.rules, `${lang}: the rule mentioning the AI has a variant`);
    const texts = [off.intro, ...off.golden.rules, ...off.chapters.flatMap((c) => [c.title, c.intro, c.tip, c.warning, ...c.steps.flatMap((s) => [s.title, s.text, s.tabLabel])])].filter(Boolean);
    for (const x of texts) assert.doesNotMatch(x, AI_WORDS, `${lang}: ${x}`);

    const on = guideFor(lang, true);
    assert.equal(on, GUIDE[lang]);
    assert.ok(on.chapters.some((c) => c.id === 'ai'), `${lang}: AI chapter shown while AI is on`);
  }
});

test('UI texts used while AI is off exist in EN and DE and promise no AI', () => {
  for (const key of ['tab.explain', 'ap.titleNoAi', 'ap.introNoAi', 'ap.noPlansNoAi', 'tour.assistantNoAi.title', 'tour.assistantNoAi.text', 'tt.noteFailed']) {
    for (const lang of ['en', 'de']) {
      const text = t(lang, key);
      assert.ok(text && text !== key, `${key} (${lang}) exists`);
      assert.doesNotMatch(text, AI_WORDS, `${key} (${lang})`);
    }
  }
  // the AI output label stays as it is
  assert.equal(t('en', 'ai.generated'), 'AI-generated – please review');
  assert.equal(t('de', 'ai.generated'), 'KI-generiert – bitte prüfen');
});

// ---------------------------------------------------------------- source check

const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (rel) => lf(fs.readFileSync(path.join(UI, rel), 'utf8'));
const uiFiles = () => {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'mock') walk(p); } else if (/\.(jsx?)$/.test(f)) out.push(p);
    }
  };
  walk(UI);
  return out;
};

// Every AI entry point in the UI, by the text it renders or the component/call it uses
const ENTRY_POINTS = [
  /t\('ap\.planCopilot'\)/, // "Plan with AI" (Autopilot and Bulk)
  /t\('ap\.planRovo'\)/, // "Plan in Rovo chat"
  /t\('app\.askRovo'\)/, // "Ask Rovo" (header, Health, transition drawer, Assistant)
  /t\('fix\.ai'\)/, // "Fix with AI" (Health)
  /<AiChat\b/, // AI chat (Assistant)
  /t\('as\.rovo(?:Title|Send|Placeholder)'\)/, // Rovo card (Assistant)
  /t\('as\.starters'\)/, // Rovo starter prompts
  /t\('ap\.placeholder'\)/, // free-text request for the Copilot (Autopilot)
  /t\('bulkap\.aiPlaceholder'\)/, // Bulk "Describe (AI)"
  /t\('ap\.(?:title|intro|noPlans)'\)/, // Autopilot texts that invite describing a change
  /t\('tab\.assistant'\)/, // "AI assistant" tab name
];
// A guard is the effective flag (or a value derived from it) used as a condition
const GUARD = /\b(?:aiOn|canAi)\s*(?:&&|\?)/;
const OPENER = /\{\s*(?:[\w.!]+\s*&&\s*)*\b(?:aiOn|canAi)\b[^{}]*&&\s*\($/;
const indent = (l) => l.match(/^\s*/)[0].length;

/** Is line i guarded on the same line, or inside an open `{aiOn && (` block? */
function guarded(lines, i) {
  if (GUARD.test(lines[i])) return true;
  for (let o = i - 1; o >= 0 && o >= i - 40; o--) {
    if (!OPENER.test(lines[o].trimEnd()) || indent(lines[o]) >= indent(lines[i])) continue;
    const closed = lines.slice(o + 1, i).some((l) => indent(l) === indent(lines[o]) && /^\s*\)\}/.test(l));
    if (!closed) return true;
  }
  return false;
}

test('source check: every AI entry point in the UI is rendered only while AI is effectively on', () => {
  const found = [];
  for (const file of uiFiles()) {
    const rel = path.relative(UI, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!ENTRY_POINTS.some((re) => re.test(line))) return;
      // the AI chat's own texts live inside AiChat, which is only mounted behind the flag (checked via <AiChat)
      found.push(`${rel}:${i + 1}`);
      assert.ok(guarded(lines, i), `unguarded AI entry point ${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  // the check really looked at the known places
  for (const f of ['App.jsx', 'components/Assistant.jsx', 'components/Autopilot.jsx', 'components/BulkAutopilot.jsx', 'components/Health.jsx', 'components/Transitions.jsx']) {
    assert.ok(found.some((x) => x.replace(/\\/g, '/').startsWith(`${f}:`)), `entry points found in ${f}`);
  }
  assert.ok(found.length >= 15, `found ${found.length} entry points`);
});

test('source check: AI actions refuse while off, the AI template and tour/guide follow the flag, no "AI is off" notice', () => {
  const all = uiFiles().map((f) => [path.relative(UI, f), lf(fs.readFileSync(f, 'utf8'))]);
  for (const [rel, src] of all) {
    assert.doesNotMatch(src, /AiOffNotice/, `${rel}: the greyed-out notice is gone`);
    // the flag is only read through useAiOn/isAiOn, so "stopped" can never be overlooked
    if (rel !== path.join('lib', 'aiState.js')) assert.doesNotMatch(src.replace(/^\s*(\/\/|\*).*$/gm, ''), /\bai\?*\.enabled\b/, `${rel}: reads ai.enabled directly`);
    // 'ai.off' / 'ai.stopped' only as the error text of a refused request (aiErrorText), never as a standing notice
    if (/t\('ai\.(?:off|stopped)'\)/.test(src)) assert.equal(rel, path.join('components', 'common.jsx'), rel);
  }
  const app = read('App.jsx');
  assert.match(app, /const askRovo = \(prompt\) => \(aiOn \?/, 'askRovo does nothing while AI is off');
  assert.match(app, /effectiveAi\(b\)/, 'start-up uses the effective flag from bootstrap');
  assert.match(app, /fetchEffectiveAi\(\(\) => call\('bootstrap'\)\)/, 're-check on focus / visibility');
  assert.match(app, /addEventListener\('visibilitychange'/);
  assert.match(app, /aiOn \? t\('tab\.assistant'\) : t\('tab\.explain'\)/);

  const ap = read('components/Autopilot.jsx');
  assert.match(ap, /const planWithCopilot = \(\) => aiOn &&/);
  assert.match(ap, /const planInRovo = \(\) => aiOn &&/);
  assert.match(ap, /intent\.text && aiOn/, 'a Copilot request handed over from Health is ignored while AI is off');
  // non-AI tools stay unconditional
  assert.match(ap, /\n\s*<button[^\n]*onClick=\{autofix\}/);
  assert.match(ap, /\n\s*<button[^\n]*t\('ap\.templates'\)/);

  const as = read('components/Assistant.jsx');
  assert.match(as, /const ask = async \(text\) => \{\n\s*if \(!aiOn\) return;/);
  assert.match(as, /describeWorkflow\(/, 'plain-language explanations stay');

  const bulk = read('components/BulkAutopilot.jsx');
  assert.match(bulk, /TEMPLATES\.filter\(\(k\) => aiOn \|\| k !== 'ai'\)/);
  assert.match(bulk, /if \(!aiOn && tpl === 'ai'\) setTpl\('removeRef'\)/);
  assert.match(bulk, /const planAi = async \(\) => \{\n\s*if \(!aiOn\) return;/);

  assert.match(read('components/Tour.jsx'), /s === 'assistant' && !aiOn \? 'assistantNoAi'/);
  assert.match(read('components/Guide.jsx'), /guideFor\(t\.lang, useAiOn\(\)\)/);
  // the admin page keeps its AI switch card
  assert.match(app, /caps\.jiraAdmin && <AiSettings/);
});
