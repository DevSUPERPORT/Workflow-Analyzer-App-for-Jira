// Compact workflow snapshots (stored in Forge KVS) and structural diffs between two snapshots.

import { allRules } from './engine.js';

function hash(str) {
  // FNV-1a 32 bit, hex
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stable(obj) {
  if (obj == null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stable).join(',')}]`;
  return `{${Object.keys(obj).sort().filter((k) => k !== 'id').map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

export function ruleSignature(r) {
  return `${r.kind}|${r.ruleKey}|${r.vendor.key}|${hash(stable(r.params))}`;
}

export function makeSnapshot(model, meta = {}) {
  return {
    v: 1,
    takenAt: meta.takenAt || new Date().toISOString(),
    by: meta.by || null,
    label: meta.label || '',
    projectKey: model.project?.key || null,
    stats: { workflows: model.stats.workflows, statuses: model.stats.statuses, transitions: model.stats.transitions, healthScore: model.stats.healthScore },
    workflows: model.workflows.map((wf) => ({
      id: wf.id,
      n: wf.name,
      it: wf.issueTypes.map((i) => i.name),
      s: wf.statuses.map((s) => [s.ref, s.name, s.category]),
      t: wf.transitions.map((t) => ({
        i: t.id,
        n: t.name,
        y: t.type,
        f: t.from.map((f) => f.name),
        to: t.to?.name || null,
        sc: t.screen?.name || null,
        r: allRules(t).map((r) => [ruleSignature(r), `${r.vendor.name}: ${r.label || r.fallbackName || r.nameKey || r.ruleKey}`, r.kind]),
      })),
    })),
  };
}

/**
 * Diff two snapshots (older `a`, newer `b`). Returns a list of changes:
 * { type: 'workflow'|'status'|'transition'|'rule', op: 'added'|'removed'|'changed', wf, name, detail }
 */
export function diffSnapshots(a, b) {
  const changes = [];
  const byId = (arr) => new Map(arr.map((w) => [w.id, w]));
  const A = byId(a.workflows);
  const B = byId(b.workflows);
  for (const [id, wf] of B) if (!A.has(id)) changes.push({ type: 'workflow', op: 'added', wf: wf.n, name: wf.n });
  for (const [id, wf] of A) if (!B.has(id)) changes.push({ type: 'workflow', op: 'removed', wf: wf.n, name: wf.n });

  for (const [id, wb] of B) {
    const wa = A.get(id);
    if (!wa) continue;
    if (wa.n !== wb.n) changes.push({ type: 'workflow', op: 'changed', wf: wb.n, name: wb.n, detail: { field: 'name', from: wa.n, to: wb.n } });
    const ita = wa.it.join(', ');
    const itb = wb.it.join(', ');
    if (ita !== itb) changes.push({ type: 'workflow', op: 'changed', wf: wb.n, name: wb.n, detail: { field: 'issueTypes', from: ita, to: itb } });

    const sa = new Map(wa.s.map((s) => [s[0], s]));
    const sb = new Map(wb.s.map((s) => [s[0], s]));
    for (const [r, s] of sb) if (!sa.has(r)) changes.push({ type: 'status', op: 'added', wf: wb.n, name: s[1] });
    for (const [r, s] of sa) if (!sb.has(r)) changes.push({ type: 'status', op: 'removed', wf: wb.n, name: s[1] });
    for (const [r, s] of sb) {
      const o = sa.get(r);
      if (o && (o[1] !== s[1] || o[2] !== s[2])) changes.push({ type: 'status', op: 'changed', wf: wb.n, name: s[1], detail: { field: o[1] !== s[1] ? 'name' : 'category', from: o[1] !== s[1] ? o[1] : o[2], to: o[1] !== s[1] ? s[1] : s[2] } });
    }

    const ta = new Map(wa.t.map((t) => [t.i, t]));
    const tb = new Map(wb.t.map((t) => [t.i, t]));
    for (const [i, t] of tb) if (!ta.has(i)) changes.push({ type: 'transition', op: 'added', wf: wb.n, name: t.n, detail: { path: `${t.f.join(', ') || '*'} → ${t.to || '↺'}` } });
    for (const [i, t] of ta) if (!tb.has(i)) changes.push({ type: 'transition', op: 'removed', wf: wb.n, name: t.n, detail: { path: `${t.f.join(', ') || '*'} → ${t.to || '↺'}` } });
    for (const [i, t] of tb) {
      const o = ta.get(i);
      if (!o) continue;
      for (const [field, x, y] of [['name', o.n, t.n], ['to', o.to, t.to], ['from', o.f.join(', '), t.f.join(', ')], ['screen', o.sc, t.sc]]) {
        if ((x || '') !== (y || '')) changes.push({ type: 'transition', op: 'changed', wf: wb.n, name: t.n, detail: { field, from: x, to: y } });
      }
      const ra = new Map(o.r.map((r) => [r[0], r]));
      const rb = new Map(t.r.map((r) => [r[0], r]));
      for (const [sig, r] of rb) if (!ra.has(sig)) changes.push({ type: 'rule', op: 'added', wf: wb.n, name: t.n, detail: { rule: r[1], kind: r[2] } });
      for (const [sig, r] of ra) if (!rb.has(sig)) changes.push({ type: 'rule', op: 'removed', wf: wb.n, name: t.n, detail: { rule: r[1], kind: r[2] } });
    }
  }
  return changes;
}

// Split a JSON-serialisable value into chunks that fit Forge KVS value limits.
export function chunkString(str, size = 180000) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [''];
}

/** Content hash of a snapshot (ignores timestamps/labels) – used by monitoring to detect changes. */
export function snapshotHash(snap) {
  return hash(JSON.stringify(snap.workflows));
}
