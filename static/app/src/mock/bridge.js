/**
 * Local mock of @forge/bridge used with `vite --mode mock`: serves fixture data and simulates every resolver so
 * the UI, exports and language switching can be tested in a normal browser without Jira. URL hashes switch
 * scenarios, including #maintenance=on and #maintenance=readonly for the kill-switch screens, #ai=on, #ai=off and
 * #ai=limit for the per-site AI switch and the monthly quota (without a hash the switch is stored like on a site:
 * off until it is turned on in the site page's Settings tab), #ai=stopped for AI turned off by SUPERPORT, and
 * #budget=<AI_BUDGET JSON, URL-encoded> for other limits, e.g. #admin&budget=%7B%22callsPerMonth%22%3A50%7D.
 *
 * @file        static/app/src/mock/bridge.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { makeProcurementBundle } from '../../../../tests/fixtures/procurement.js';
import { parseAiBudget, siteBudget } from '../../../../src/lib/aiBudget.js';

const isSite = () => /^#admin/.test(window.location.hash);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = 'superport.wfa.mock';
const load = () => {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
};
const save = (s) => {
  try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* ignore */ }
};

export const view = {
  async getContext() {
    return {
      accountId: 'mock-user',
      cloudId: 'mock-cloud',
      siteUrl: 'https://superportdev.atlassian.net',
      locale: 'de-DE',
      moduleKey: isSite() ? 'workflow-analyzer-admin' : 'workflow-analyzer-project',
      extension: isSite() ? { type: 'jira:adminPage' } : { type: 'jira:projectSettingsPage', project: { id: '10100', key: 'IDE', type: 'software' } },
    };
  },
  theme: { async enable() { document.documentElement.setAttribute('data-color-mode', /dark/.test(location.hash) ? 'dark' : 'light'); } },
};

export const router = {
  open(url) { window.open(url, '_blank'); },
  navigate(url) { window.open(url, '_blank'); },
};

export const rovo = {
  async isEnabled() { return !/norovo/.test(location.hash); },
  async open(payload) { window.__lastRovo = payload; console.info('[mock] rovo.open', payload); },
};

const ok = (data) => ({ ok: true, data });

// Issues with a resolution that does not match their status (persisted in the mock store so repairs stick)
function mockIssues(s) {
  if (!s.resIssues) {
    const DONE = [{ id: '10287', name: 'Ware geliefert', category: 'DONE' }, { id: '10286', name: 'Bestellung abgeschlossen', category: 'DONE' }, { id: '10301', name: 'Nicht genehmigt', category: 'DONE' }];
    const things = ['Laptop für Neuzugang', 'Monitor 27 Zoll', 'Lizenz Adobe CC', 'Headset Vertrieb', 'Docking-Station', 'Tastatur DE', 'iPhone Ersatz', 'Beamer Raum 4', 'Server-RAM', 'Webcam HR'];
    s.resIssues = Array.from({ length: 23 }, (_, i) => ({ key: `IDE-${101 + i}`, summary: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}`, status: DONE[i % 3], res: null, updated: new Date(Date.now() - i * 36e5 * 7).toISOString() }));
    s.resIssues.push({ key: 'IDE-140', summary: 'Wieder geöffnet: Drucker', status: { id: '10640', name: 'GB-Kontrolle', category: 'IN_PROGRESS' }, res: '10000', updated: new Date().toISOString() });
  }
  return s.resIssues;
}

async function mockPlan(s, ops, instructions, explanation, source, lang) {
  const { dryRun } = await import('../../../../src/shared/autopilot.js');
  const b = makeProcurementBundle();
  const wf = b.workflows[0];
  const dr = dryRun(b, wf.id, ops, { lang });
  const slim = (f) => ({ id: f.id, code: f.code, severity: f.severity, wfName: f.wfName, tName: f.tName, params: f.params, ruleLabel: f.ruleLabel, vendor: f.vendor });
  const plan = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    workflowId: wf.id,
    baseVersion: wf.version || null,
    lang,
    workflowName: wf.name,
    title: String(instructions || `${ops.length} operation(s)`).slice(0, 140),
    instructions,
    explanation,
    source,
    ops,
    results: dr.results.map((r) => ({ op: r.op, ok: r.ok, message: r.message })),
    changes: dr.changes,
    healthBefore: dr.healthBefore,
    healthAfter: dr.healthAfter,
    fixed: dr.fixed.map(slim),
    introduced: dr.introduced.map(slim),
    sharedProjects: /shared/.test(location.hash) ? [{ key: 'IDE' }, { key: 'KAN' }] : [{ key: 'IDE' }],
    validation: { ok: true, errors: [], warnings: [] },
    status: dr.results.some((r) => r.ok) ? 'planned' : 'invalid',
    createdAt: new Date().toISOString(),
    createdByName: 'Mock Admin',
  };
  s.plans = { ...(s.plans || {}), [plan.id]: plan };
  save(s);
  return plan;
}

// #maintenance=on / #maintenance=readonly previews the kill-switch screens (the real switch is APP_MAINTENANCE on
// the server). Mirrors READS in src/index.js: in read-only mode everything else is refused.
const MOCK_READS = new Set(['bootstrap', 'getProjectData', 'getNotes', 'listSnapshots', 'getSnapshot', 'siteScanPage', 'siteRefs', 'siteProjects', 'getStatusLoad', 'getIssueTypes', 'getRemediation', 'getMonitoring', 'aiAsk', 'listPlans', 'getPlan', 'siteBulkList', 'siteBulkGet', 'resolutionAudit', 'resolutionIssues', 'resolutionRuns', 'getAiSettings']);
const STATUS_URL = 'https://superapps.statuspage.io';
const maintenanceMode = () => (window.location.hash.match(/maintenance=(on|readonly)/) || [])[1] || 'off';

// AI switch and quota (server: lib/ai.js). #ai=on / #ai=off force the switch, #ai=limit simulates a used-up quota,
// #ai=stopped SUPERPORT's stop (the stored switch is kept). #budget=<URL-encoded AI_BUDGET JSON> is parsed like on
// the server (lib/aiBudget.js) for the mock site superportdev.atlassian.net.
const MOCK_HOST = 'superportdev.atlassian.net';
const aiHash = () => (window.location.hash.match(/ai=(on|off|limit|stopped)/) || [])[1] || null;
function aiCaps() {
  const raw = (window.location.hash.match(/budget=([^&]+)/) || [])[1];
  let json = '';
  try { json = raw ? decodeURIComponent(raw) : ''; } catch { /* malformed: defaults */ }
  const { budget, error } = parseAiBudget(json);
  if (error) console.warn('[mock] #budget ignored:', error);
  const caps = siteBudget(budget, MOCK_HOST);
  return aiHash() === 'stopped' ? { ...caps, stop: true } : caps;
}
const aiOn = (s) => (aiHash() && aiHash() !== 'stopped' ? aiHash() !== 'off' : s.aiEnabled === true);
function aiUsage(s, c = aiCaps()) {
  const month = new Date().toISOString().slice(0, 7);
  const limits = { calls: c.callsPerMonth, tokens: c.tokensPerMonth };
  const u = aiHash() === 'limit' ? { calls: Math.floor(limits.calls * 0.4), tokens: Math.floor(limits.tokens * 0.37), eur: c.eurPerMonth * 0.985 } : s.llmUsage?.month === month ? s.llmUsage : { calls: 0, tokens: 0, eur: 0 };
  const eur = Math.round((u.eur || 0) * 10000) / 10000;
  return { month, calls: u.calls, tokens: u.tokens, eur, eurLimit: c.eurPerMonth, limits, exhausted: u.calls >= limits.calls || u.tokens >= limits.tokens || eur >= c.eurPerMonth * 0.98 };
}
const AI_TEXT = {
  AI_STOPPED: { de: 'Die KI-Funktionen sind vorübergehend vom App-Anbieter ausgeschaltet. Bitte versuchen Sie es später erneut.', en: 'AI features are temporarily turned off by the app vendor. Please try again later.' },
  AI_DISABLED: { de: 'Die KI-Funktionen sind deaktiviert. Ein Jira-Administrator kann sie in den App-Einstellungen aktivieren.', en: 'AI features are turned off. A Jira administrator can turn them on in the app settings.' },
  AI_LIMIT: { de: 'Das monatliche KI-Kontingent ist aufgebraucht. Es steht ab dem 1. des nächsten Monats wieder zur Verfügung.', en: 'The monthly AI quota is used up. It is available again from the 1st of next month.' },
};
/** null when the AI request may go ahead (and is counted), otherwise the refusal the server would send. */
function aiGate(s, lang) {
  const code = aiCaps().stop ? 'AI_STOPPED' : !aiOn(s) ? 'AI_DISABLED' : aiUsage(s).exhausted ? 'AI_LIMIT' : null;
  if (code) return { ok: false, error: code, message: AI_TEXT[code][lang === 'de' ? 'de' : 'en'] };
  const u = aiUsage(s);
  const tok = 2400 + Math.floor(Math.random() * 1800);
  s.llmUsage = { month: u.month, calls: u.calls + 1, tokens: u.tokens + tok, eur: (u.eur || 0) + (tok * 0.8 * 3 + tok * 0.2 * 15) / 1e6 };
  save(s);
  return null;
}

export async function invoke(name, payload = {}) {
  await wait(name === 'getProjectData' ? 500 : 120);
  const mode = maintenanceMode();
  const unlicensed = /license=inactive/.test(window.location.hash);
  if (name === 'availability') return ok({ mode, statusUrl: STATUS_URL, licensed: !unlicensed });
  if (unlicensed) return { ok: false, error: 'LICENSE_INACTIVE', message: 'The Workflow Analyzer for Jira licence for this site is not active.' };
  if (mode === 'on') return { ok: false, error: 'UNAVAILABLE', mode, message: `Workflow Analyzer for Jira is temporarily unavailable. We've paused it for maintenance to keep your data safe. Status page: ${STATUS_URL}` };
  if (mode === 'readonly' && !MOCK_READS.has(name)) return { ok: false, error: 'UNAVAILABLE', mode, message: `Changes are paused for maintenance to keep your data safe. Status page: ${STATUS_URL}` };
  const s = load();
  switch (name) {
    case 'bootstrap':
      return ok({
        mode: isSite() ? 'site' : 'project',
        project: isSite() ? null : { id: '10100', key: 'IDE' },
        user: { accountId: 'mock-user', displayName: 'Mock Admin', locale: 'de_DE' },
        prefs: s.prefs || {},
        allowed: !/forbidden/.test(location.hash),
        isJiraAdmin: !/role=project/.test(location.hash),
        // #role=project simulates a project admin who is not a Jira admin (role-aware UI)
        caps: /forbidden/.test(location.hash)
          ? { role: 'none', jiraAdmin: false, projectAdmin: false, changeShared: false, changeProjectScoped: false, createTasks: false, bulk: false }
          : /role=project/.test(location.hash)
            ? { role: 'project-admin', jiraAdmin: false, projectAdmin: true, changeShared: false, changeProjectScoped: true, createTasks: true, bulk: false }
            : { role: 'jira-admin', jiraAdmin: true, projectAdmin: true, changeShared: true, changeProjectScoped: true, createTasks: true, bulk: isSite() },
        ai: { enabled: aiOn(s) && !aiCaps().stop, stopped: aiCaps().stop },
      });
    case 'getAiSettings':
    case 'setAiSettings': {
      if (/role=project|forbidden/.test(location.hash)) return { ok: false, error: 'FORBIDDEN_SITE' };
      if (name === 'setAiSettings') {
        if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'FAILED', message: 'enabled must be true or false' };
        s.aiEnabled = payload.enabled;
        s.aiChanged = { at: new Date().toISOString(), byName: 'Mock Admin' };
        save(s);
        if (aiHash()) console.info('[mock] #ai= in the URL overrides the stored switch');
      }
      return ok({ enabled: aiOn(s), stopped: aiCaps().stop, updatedAt: s.aiChanged?.at || null, updatedByName: s.aiChanged?.byName || null, usage: aiUsage(s) });
    }
    case 'setPrefs':
      s.prefs = { ...(s.prefs || {}), ...payload };
      save(s);
      return ok(s.prefs);
    case 'getProjectData':
      if (/fail/.test(location.hash)) return { ok: false, error: 'FAILED', message: 'Mock failure' };
      return ok({ bundle: makeProcurementBundle(), notes: s.notes || {} });
    case 'getNotes':
      return ok(s.notes || {});
    case 'saveNote': {
      s.notes = s.notes || {};
      const n = (s.notes[payload.workflowId] ||= {});
      if (!String(payload.text || '').trim()) delete n[payload.transitionId];
      else n[payload.transitionId] = { text: payload.text, by: 'mock-user', byName: 'Mock Admin', at: new Date().toISOString() };
      save(s);
      return ok(n[payload.transitionId] || null);
    }
    case 'listSnapshots':
      return ok(s.snapshots || []);
    case 'saveSnapshot': {
      const { normalize } = await import('../../../../src/shared/engine.js');
      const { makeSnapshot } = await import('../../../../src/shared/snapshot.js');
      const b = makeProcurementBundle();
      // Simulate an older state: different transition name and one transition less
      if ((s.snapshots || []).length === 0) {
        b.workflows[0].transitions[2].name = 'Freigeben (alt)';
        b.workflows[0].transitions.push({ id: '777', name: 'Alte Abkürzung', type: 'DIRECTED', toStatusReference: 'ref-10286', links: [{ fromStatusReference: 'ref-10288' }], conditions: { operation: 'ALL', conditions: [], conditionGroups: [] }, validators: [], actions: [] });
      }
      const snap = makeSnapshot(normalize(b), { label: payload.label, by: 'Mock Admin' });
      const id = Date.now().toString(36);
      s.snapshots = [{ id, takenAt: snap.takenAt, by: snap.by, label: snap.label, stats: snap.stats, chunks: 1 }, ...(s.snapshots || [])];
      s.snapData = { ...(s.snapData || {}), [id]: snap };
      save(s);
      return ok(s.snapshots[0]);
    }
    case 'getSnapshot':
      return ok((s.snapData || {})[payload.id] || null);
    case 'deleteSnapshot':
      s.snapshots = (s.snapshots || []).filter((x) => x.id !== payload.id);
      save(s);
      return ok(true);
    case 'siteScanPage': {
      const b = makeProcurementBundle();
      const extra = JSON.parse(JSON.stringify(b.workflows[1]));
      extra.id = 'b7a1d1c0-0000-4000-8000-000000000003';
      extra.name = 'Software Simplified Workflow';
      const all = [...b.workflows, extra];
      const page = all.slice(payload.startAt || 0, (payload.startAt || 0) + 2);
      return ok({ total: all.length, isLast: (payload.startAt || 0) + 2 >= all.length, nextStartAt: (payload.startAt || 0) + page.length, workflows: page, statuses: b.statuses });
    }
    case 'siteRefs':
      return ok({ ref: makeProcurementBundle().ref, warnings: [] });
    case 'siteProjects': {
      const usage = {};
      for (const id of payload.workflowIds) usage[id] = id.endsWith('3') ? [{ id: '10200', key: 'KAN', name: 'Kanban Demo' }, { id: '10300', key: 'OPS', name: 'IT Operations' }] : [{ id: '10100', key: 'IDE', name: 'IT-Bedarf' }];
      return ok({ usage, warnings: [] });
    }
    case 'getStatusLoad': {
      const byStatus = {};
      const counts = { 10289: 4, 10288: 3, 10290: 2, 10640: 14, 10339: 2, 10341: 3, 10300: 1, 10286: 40, 10287: 25, 10301: 6, 10999: 0, 10291: 1, 10292: 2, 10302: 3, 10338: 2, 1: 5, 3: 4, 10001: 18 };
      for (const id of payload.statusIds) byStatus[id] = { count: counts[id] ?? 0, stale: id === '10640' ? 9 : id === '10302' ? 2 : 0, ever: counts[id] ? counts[id] + 3 : id === '10999' ? 0 : 2 };
      return ok({ byStatus, total: 46, all: 135, staleDays: payload.staleDays || 30, at: new Date().toISOString() });
    }
    case 'getIssueTypes':
      return ok([{ id: '10010', name: 'Aufgabe' }, { id: '10011', name: 'Bug' }]);
    case 'getRemediation':
      return ok(s.rem || {});
    case 'createRemediation': {
      s.rem = s.rem || {};
      const created = [];
      const skipped = [];
      let n = 100 + Object.keys(s.rem).length;
      for (const it of payload.items) {
        if (s.rem[it.fingerprint]) { skipped.push({ fingerprint: it.fingerprint, key: s.rem[it.fingerprint].key }); continue; }
        const key = `${payload.projectKey || 'IDE'}-${++n}`;
        s.rem[it.fingerprint] = { key, at: new Date().toISOString(), by: 'Mock Admin' };
        created.push({ fingerprint: it.fingerprint, key });
      }
      save(s);
      return ok({ created, skipped });
    }
    case 'getMonitoring':
      return ok({ enabled: !!s.monitor, state: s.monitorState || null });
    case 'setMonitoring':
      s.monitor = !!payload.enabled;
      s.monitorState = s.monitor ? { lastRun: new Date().toISOString(), baselineAt: new Date().toISOString(), healthScore: 67, high: 3 } : s.monitorState;
      save(s);
      return ok({ enabled: s.monitor, state: s.monitorState });
    case 'touchVisit':
      // #digest simulates a previous visit that knew only part of today's findings
      if (/digest/.test(location.hash) && Array.isArray(payload.findings)) return ok({ lastSeen: '2026-10-14T08:00:00.000Z', state: null, previous: { at: '2026-10-14T08:00:00.000Z', keys: [...payload.findings.slice(2), 'gone1', 'gone2', 'gone3'] } });
      return ok({
        lastSeen: '2026-10-14T08:00:00.000Z',
        state: /changed/.test(location.hash) ? { lastRun: new Date().toISOString(), lastChangeAt: '2026-10-20T03:00:00.000Z', lastChangeCount: 3, newHigh: 1, lastChanges: [{ type: 'transition', op: 'added', wf: 'IDE: Bedarfsworkflow', name: 'Ablehnen' }] } : s.monitorState || null,
      });
    case 'aiAsk': {
      const refused = aiGate(s, payload.lang);
      if (refused) return refused;
      await wait(700);
      return ok({ answer: `(Mock) Zur Frage „${payload.question}“: Der Workflow „IDE: Bedarfsworkflow“ hat 15 Status. Die Transition „GB OK“ dürfen nur Mitglieder von „Procurement“ und zusätzlich „recht“ oder der Melder ausführen.`, model: 'claude-sonnet-5 (mock)' });
    }
    case 'siteBulkAi': {
      const refused = aiGate(s, payload.lang);
      if (refused) return refused;
      await wait(900);
      return ok({ operations: [{ op: 'requireFields', transition: '@done', fields: ['Resolution'], message: 'Please set a resolution' }], explanation: '(Mock) Every transition into a Done status gets a validator that requires the resolution.', model: 'claude-sonnet-5 (mock)' });
    }
    case 'aiPlan': {
      const refused = aiGate(s, payload.lang);
      if (refused) return refused;
      await wait(900);
      const text = String(payload.instructions || '').toLowerCase();
      const ops = /eskal|escal/.test(text)
        ? [{ op: 'addStatus', name: 'Eskaliert', category: 'IN_PROGRESS' }, { op: 'addTransition', name: 'Eskalieren', from: ['GB-Kontrolle', 'GB-Klärung'], to: 'Eskaliert' }, { op: 'addTransition', name: 'Deeskalieren', from: 'Eskaliert', to: 'GB-Kontrolle' }, { op: 'restrictTransition', transition: 'Eskalieren', roles: ['Administrators'] }]
        : /pflicht|require/.test(text)
          ? [{ op: 'requireFields', transition: 'Bestellung abschließen', fields: ['Warengruppe', 'GB erforderlich?'], message: 'Bitte Warengruppe und GB angeben' }]
          : [];
      const explanation = ops.length ? '(Mock) Ich lege den Status „Eskaliert“ an, erlaube die Eskalation aus GB-Kontrolle und GB-Klärung nur für Administratoren und ergänze einen Rückweg.' : '(Mock) Die Anfrage ist nicht eindeutig – bitte Status und Transition nennen.';
      if (!ops.length) return ok({ plan: null, explanation, model: 'claude-sonnet-5 (mock)' });
      const plan = await mockPlan(s, ops, payload.instructions, explanation, 'copilot');
      return ok({ plan, explanation, model: 'claude-sonnet-5 (mock)' });
    }
    case 'createPlan':
      return ok(await mockPlan(s, payload.ops, payload.instructions, '', 'ui', payload.lang));
    case 'replanPlan': {
      const old = s.plans[payload.id];
      const plan = await mockPlan(s, old.ops, old.instructions || old.title, old.explanation, old.source, payload.lang);
      if (old.status === 'planned' || old.status === 'invalid') old.status = 'discarded';
      save(s);
      return ok(plan);
    }
    case 'autofixPlan': {
      const { normalize } = await import('../../../../src/shared/engine.js');
      const { autofixOperations } = await import('../../../../src/shared/autopilot.js');
      const b = makeProcurementBundle();
      const m = normalize(b);
      const wf = m.workflows[0];
      const { findingFingerprint } = await import('../../../../src/shared/insights.js');
      const only = Array.isArray(payload.fingerprints) ? new Set(payload.fingerprints) : null;
      const { ops, manual } = autofixOperations(m, m.findings.filter((f) => f.wfId === wf.id && (!only || only.has(findingFingerprint(f)))), b.ref.resolutions);
      if (!ops.length) return { ok: false, error: 'NOTHING_TO_FIX', message: payload.lang === 'de' ? 'Für diese Befunde gibt es keine automatische Korrektur.' : 'There is no automatic fix for these findings.' };
      const n = new Set(ops.map((o) => o._f)).size;
      const plan = await mockPlan(s, ops.map(({ _f, _wf, ...o }) => o), payload.lang === 'de' ? `Automatische Korrektur von ${n} Befund${n === 1 ? '' : 'en'} in „${wf.name}“` : `Auto-fix ${n} finding${n === 1 ? '' : 's'} in "${wf.name}"`, '', 'autofix', payload.lang);
      plan.manual = manual.filter((f) => !plan.fixed.some((x) => x.id === f.id)).map((f) => ({ id: f.id, code: f.code, severity: f.severity, wfName: f.wfName, tName: f.tName, params: f.params, ruleLabel: f.ruleLabel, vendor: f.vendor }));
      s.plans[plan.id] = plan;
      save(s);
      return ok(plan);
    }
    case 'listPlans':
      return ok(Object.values(s.plans || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => ({ id: p.id, status: p.status, createdAt: p.createdAt, workflowName: p.workflowName, source: p.source, title: p.title, opCount: p.ops.length })));
    case 'getPlan':
      return ok((s.plans || {})[payload.id] || null);
    case 'applyPlan': {
      await wait(900);
      const p = s.plans[payload.id];
      if (p.sharedProjects.length > 1 && !payload.confirmShared) return { ok: false, error: 'SHARED_CONFIRM', message: 'shared' };
      p.status = 'applied';
      p.appliedAt = new Date().toISOString();
      p.appliedBy = 'Mock Admin';
      save(s);
      return ok(p);
    }
    case 'rollbackPlan': {
      const p = s.plans[payload.id];
      p.status = 'rolledback';
      save(s);
      return ok(p);
    }
    case 'discardPlan':
      s.plans[payload.id].status = 'discarded';
      save(s);
      return ok(true);
    case 'siteBulkList':
      return ok(Object.values(s.bulks || {}).map((b) => ({ id: b.id, title: b.title, createdAt: b.createdAt, targets: b.children.length, counts: {} })));
    case 'siteBulkGet':
      return ok((s.bulks || {})[payload.id]);
    case 'siteBulkCreate': {
      const b = { id: Date.now().toString(36), title: payload.instructions, createdAt: new Date().toISOString(), createdByName: 'Mock Admin', ops: payload.ops || [], autofix: payload.autofix, children: payload.workflowIds.map((workflowId) => ({ workflowId, status: 'pending' })) };
      s.bulks = { ...(s.bulks || {}), [b.id]: b };
      save(s);
      return ok(b);
    }
    case 'siteBulkPlanBatch': {
      const { dryRun } = await import('../../../../src/shared/autopilot.js');
      const b = s.bulks[payload.bulkId];
      const fx = makeProcurementBundle();
      for (const ch of b.children.filter((c) => c.status === 'pending').slice(0, 5)) {
        const raw = fx.workflows.find((w) => w.id === ch.workflowId) || fx.workflows[1];
        let ops = b.ops;
        if (b.autofix) {
          const { normalize } = await import('../../../../src/shared/engine.js');
          const { autofixOperations } = await import('../../../../src/shared/autopilot.js');
          const { findingFingerprint } = await import('../../../../src/shared/insights.js');
          const m = normalize(fx);
          const want = new Set(b.autofix.fingerprints);
          ops = autofixOperations(m, m.findings.filter((f) => f.wfId === raw.id && want.has(findingFingerprint(f))), fx.ref.resolutions).ops;
          if (!ops.length) { Object.assign(ch, { workflowName: raw.name, status: 'nochange', error: 'Nothing to fix automatically in this workflow (any more)' }); continue; }
        }
        const dr = dryRun(fx, raw.id, ops);
        const okReal = dr.results.some((r) => r.ok && !r.noop);
        Object.assign(ch, { workflowName: raw.name, planId: ch.workflowId, status: !dr.results.some((r) => r.ok) ? 'invalid' : okReal ? 'planned' : 'nochange', healthBefore: dr.healthBefore, healthAfter: dr.healthAfter, changes: dr.changes.length, validationOk: okReal ? true : null, shared: ['IDE'], error: dr.results.filter((r) => !r.ok).map((r) => r.message).join('; ') || undefined });
      }
      save(s);
      return ok(b);
    }
    case 'siteBulkApply': {
      await wait(400);
      const ch = s.bulks[payload.bulkId].children.find((c) => c.workflowId === payload.workflowId);
      ch.status = 'applied';
      save(s);
      return ok(ch);
    }
    case 'siteBulkRollback': {
      const ch = s.bulks[payload.bulkId].children.find((c) => c.workflowId === payload.workflowId);
      ch.status = 'rolledback';
      save(s);
      return ok(ch);
    }
    // Issue resolution check & repair (compare-and-set, run log) – mirrors src/lib/issues.js
    case 'resolutionAudit': {
      const list = mockIssues(s);
      save(s);
      if (/resfail/.test(location.hash)) return { ok: false, error: 'FAILED', message: 'Mock failure' };
      return ok({ projectKey: 'IDE', doneUnresolved: list.filter((i) => i.status.category === 'DONE' && !i.res).length, openResolved: list.filter((i) => i.status.category !== 'DONE' && i.res).length, at: new Date().toISOString() });
    }
    case 'resolutionIssues': {
      const want = payload.kind === 'openResolved' ? (i) => i.status.category !== 'DONE' && i.res : (i) => i.status.category === 'DONE' && !i.res;
      const all = mockIssues(s).filter(want);
      const start = Number(payload.nextPageToken || 0);
      const page = all.slice(start, start + 15);
      const RES = { 10000: 'Done', 10001: "Won't Do" };
      return ok({ kind: payload.kind, issues: page.map((i) => ({ key: i.key, summary: i.summary, status: i.status, resolution: i.res ? { id: i.res, name: RES[i.res] } : null, issueType: 'Bedarf', project: { key: 'IDE', name: 'IT-Bedarf' }, updated: i.updated })), nextPageToken: start + page.length < all.length ? String(start + page.length) : null });
    }
    case 'resolutionRepair': {
      await wait(350);
      const list = mockIssues(s);
      const results = (payload.items || []).map((it) => {
        const issue = list.find((i) => i.key === it.key);
        if (!issue) return { ...it, status: 'failed', code: 'NOT_FOUND' };
        if (/role=project/.test(location.hash) && issue.key.endsWith('3')) return { ...it, status: 'failed', code: 'NOT_ON_SCREEN' };
        if ((issue.res || null) === (it.to || null)) return { ...it, status: 'skipped', code: 'ALREADY_DONE' };
        if ((issue.res || null) !== (it.from || null)) return { ...it, status: 'skipped', code: 'CHANGED' };
        issue.res = it.to || null;
        return { ...it, status: 'repaired' };
      });
      s.resRuns ||= [];
      let run = s.resRuns.find((r) => r.id === payload.runId);
      if (!run) { run = { id: payload.runId, kind: payload.kind, at: new Date().toISOString(), by: 'Mock Admin', undoOf: payload.undoOf || null, items: [], failed: 0, skipped: 0 }; s.resRuns.unshift(run); }
      run.items.push(...results.filter((r) => r.status === 'repaired').map(({ key, from, to }) => ({ key, from, to })));
      run.failed += results.filter((r) => r.status === 'failed').length;
      run.skipped += results.filter((r) => r.status === 'skipped').length;
      if (payload.undoOf) { const o = s.resRuns.find((r) => r.id === payload.undoOf); if (o) o.undoneBy = payload.runId; }
      save(s);
      return ok({ results, silent: !/role=project/.test(location.hash), run: { id: run.id, items: run.items.length } });
    }
    case 'resolutionRuns':
      return ok(s.resRuns || []);
    case 'siteBulkAi':
      await wait(600);
      return ok({ operations: [{ op: 'restrictTransition', transition: '@done', roles: ['Administrators'] }], explanation: '(Mock) Restrict every transition into a Done status to the role Administrators.', model: 'mock' });
    default:
      return { ok: false, error: 'FAILED', message: `Unknown mock resolver ${name}` };
  }
}

export const showFlag = () => ({ close() {} });
