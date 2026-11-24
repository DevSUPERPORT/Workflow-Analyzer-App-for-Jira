/**
 * Daily workflow monitoring (scheduledTrigger): for every project that opted in, takes a snapshot when the
 * configuration changed and remembers what changed, shown in the UI as the change timeline and the "changed
 * since your last visit" banner. Does nothing while the kill switch is on or read-only.
 *
 * @file        src/monitor.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { getProjectBundle } from './lib/jira.js';
import * as store from './lib/store.js';
import { normalize } from './shared/engine.js';
import { makeSnapshot, diffSnapshots, snapshotHash } from './shared/snapshot.js';
import { maintenanceMode } from './lib/maintenance.js';

const MAX_PER_RUN = 15;

export async function monitorProject(project, { by = 'Workflow Analyzer (auto)' } = {}) {
  const model = normalize(await getProjectBundle(project.id));
  const snap = makeSnapshot(model, { by, label: 'auto' });
  const hash = snapshotHash(snap);
  const prev = await store.getMonitorState(project.id);
  const now = new Date().toISOString();
  const state = { ...(prev || {}), lastRun: now, hash, healthScore: model.stats.healthScore, high: model.stats.findings.high };
  if (!prev?.hash) {
    await store.saveSnapshot(project.id, { ...snap, label: 'baseline' });
    state.baselineAt = now;
  } else if (prev.hash !== hash) {
    let changes = null;
    const last = (await store.listSnapshots(project.id))[0];
    if (last) {
      const old = await store.getSnapshot(project.id, last.id);
      if (old) changes = diffSnapshots(old, snap);
    }
    // Only a real difference is a change: no earlier snapshot to compare with (or a hash that moved without any
    // visible difference) just updates the reference, so users never see "changed … (0 differences)".
    if (changes === null) {
      await store.saveSnapshot(project.id, { ...snap, label: 'baseline' });
    } else if (changes.length) {
      await store.saveSnapshot(project.id, snap);
      state.lastChangeAt = now;
      state.lastChangeCount = changes.length;
      state.lastChanges = changes.slice(0, 30);
      state.newHigh = Math.max(0, model.stats.findings.high - (prev.high || 0));
    }
  }
  await store.setMonitorState(project.id, state);
  return state;
}

export async function monitorRun() {
  // Kill switch: "on" stops everything; "readonly" stops it too, because every run writes snapshots.
  if (maintenanceMode() !== 'off') return;
  const projects = await store.getMonitoredProjects();
  // Oldest-run first so large sites are covered over several days
  const states = await Promise.all(projects.map(async (p) => ({ p, s: await store.getMonitorState(p.id) })));
  states.sort((a, b) => String(a.s?.lastRun || '').localeCompare(String(b.s?.lastRun || '')));
  for (const { p } of states.slice(0, MAX_PER_RUN)) {
    try {
      await monitorProject(p);
    } catch (e) {
      console.error('[monitor]', p.key, e?.status || '', e?.message || e);
    }
  }
}
