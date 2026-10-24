// Daily workflow monitoring (scheduledTrigger). For every project that opted in, take a
// snapshot when the configuration changed and remember what changed – shown in the UI as
// change timeline and "changed since your last visit" banner.

import { getProjectBundle } from './lib/jira.js';
import * as store from './lib/store.js';
import { normalize } from './shared/engine.js';
import { makeSnapshot, diffSnapshots, snapshotHash } from './shared/snapshot.js';

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
    let changes = [];
    const last = (await store.listSnapshots(project.id))[0];
    if (last) {
      const old = await store.getSnapshot(project.id, last.id);
      if (old) changes = diffSnapshots(old, snap);
    }
    await store.saveSnapshot(project.id, snap);
    state.lastChangeAt = now;
    state.lastChangeCount = changes.length;
    state.lastChanges = changes.slice(0, 30);
    state.newHigh = Math.max(0, model.stats.findings.high - (prev.high || 0));
  }
  await store.setMonitorState(project.id, state);
  return state;
}

export async function monitorRun() {
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
