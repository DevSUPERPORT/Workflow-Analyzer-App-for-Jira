/**
 * Workflow diagram geometry: lays out statuses and transitions and renders them as an SVG string. Pure functions
 * used by the React view, the HTML export (static SVG) and the PDF export (rasterised SVG).
 *
 * @file        src/shared/diagram.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

const NODE_H = 36;
const GAP_X = 250;
const GAP_Y = 86;

const CAT = {
  TODO: { fill: '#DFE1E6', stroke: '#8590A2', ink: '#44546F' },
  IN_PROGRESS: { fill: '#CCE0FF', stroke: '#579DFF', ink: '#0C66E4' },
  DONE: { fill: '#DCFFF1', stroke: '#4BCE97', ink: '#216E4E' },
};
export const categoryColors = (c) => CAT[c] || CAT.TODO;

function nodeWidth(name) {
  return Math.max(110, Math.min(230, String(name).length * 7.2 + 30));
}

function truncate(s, max = 30) {
  s = String(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {object} wf normalized workflow
 * @param {object} opts { mode: 'auto'|'jira', findingKeys: Set<string> }
 */
export function layoutWorkflow(wf, opts = {}) {
  const findingKeys = opts.findingKeys || new Set();
  const hasJiraLayout = wf.statuses.length > 0 && wf.statuses.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y));
  const mode = opts.mode === 'jira' && hasJiraLayout ? 'jira' : 'auto';

  const nodes = new Map();
  for (const s of wf.statuses) nodes.set(s.ref, { ref: s.ref, id: s.id, name: s.name, label: truncate(s.name), category: s.category, w: nodeWidth(truncate(s.name)), h: NODE_H, x: 0, y: 0 });

  const outgoing = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const t of wf.transitions) for (const f of t.from) if (t.to && outgoing.has(f.ref)) outgoing.get(f.ref).push(t.to.ref);

  if (mode === 'jira') {
    for (const s of wf.statuses) {
      const n = nodes.get(s.ref);
      n.x = s.x;
      n.y = s.y;
    }
  } else {
    // Layered layout (BFS ranks from the initial status)
    const init = wf.transitions.find((t) => t.isInitial)?.to?.ref;
    const rank = new Map();
    const order = [];
    const start = init && nodes.has(init) ? [init] : [...nodes.keys()].slice(0, 1);
    for (const s of start) rank.set(s, 0);
    const q = [...start];
    while (q.length) {
      const cur = q.shift();
      order.push(cur);
      for (const nx of outgoing.get(cur) || []) if (!rank.has(nx) && nodes.has(nx)) { rank.set(nx, rank.get(cur) + 1); q.push(nx); }
    }
    // Globally-reached or unreachable statuses: DONE ones to the far right, others after the max rank
    const maxRank = Math.max(0, ...rank.values());
    for (const k of nodes.keys()) {
      if (rank.has(k)) continue;
      rank.set(k, nodes.get(k).category === 'DONE' ? maxRank + 1 : maxRank + 1);
      order.push(k);
    }
    const layers = new Map();
    for (const k of order) {
      const r = rank.get(k);
      if (!layers.has(r)) layers.set(r, []);
      layers.get(r).push(k);
    }
    // Barycenter ordering, one sweep. Optional wrapping ("snake") for long workflows:
    // ranks beyond opts.wrap continue in a new band below (used by PDF/HTML exports).
    const pos = new Map();
    const sortedRanks = [...layers.keys()].sort((a, b) => a - b);
    const wrap = opts.wrap && sortedRanks.length > opts.wrap ? opts.wrap : 0;
    const maxLayer = Math.max(1, ...[...layers.values()].map((l) => l.length));
    const bandH = maxLayer * GAP_Y + GAP_Y * 1.6;
    for (const r of sortedRanks) {
      const layer = layers.get(r);
      if (r > 0) {
        const bary = (k) => {
          const preds = [...outgoing].filter(([, outs]) => outs.includes(k)).map(([p]) => pos.get(p)).filter((v) => v != null);
          return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : 1e9;
        };
        layer.sort((a, b) => bary(a) - bary(b));
      }
      layer.forEach((k, i) => pos.set(k, i - (layer.length - 1) / 2));
      layer.forEach((k, i) => {
        const n = nodes.get(k);
        const band = wrap ? Math.floor(r / wrap) : 0;
        n.x = (wrap ? r % wrap : r) * GAP_X;
        n.y = (i - (layer.length - 1) / 2) * GAP_Y + band * bandH;
      });
    }
  }

  // Virtual nodes
  const xs = [...nodes.values()];
  const minX = Math.min(0, ...xs.map((n) => n.x));
  const minY = Math.min(0, ...xs.map((n) => n.y));
  const init = wf.transitions.find((t) => t.isInitial);
  const virtual = [];
  if (init?.to && nodes.has(init.to.ref)) {
    const target = nodes.get(init.to.ref);
    virtual.push({ ref: '__start', kind: 'start', x: target.x - 90, y: target.y + NODE_H / 2 - 9, w: 18, h: 18 });
  }
  const globals = wf.transitions.filter((t) => t.isGlobal);
  if (globals.length) virtual.push({ ref: '__any', kind: 'any', x: minX - 60, y: minY - GAP_Y * 1.3, w: 120, h: 28 });
  const all = new Map([...nodes, ...virtual.map((v) => [v.ref, v])]);

  // Edges
  const pairCount = new Map();
  const edges = [];
  const center = (n) => ({ cx: n.x + n.w / 2, cy: n.y + n.h / 2 });
  for (const t of wf.transitions) {
    const sources = t.isInitial ? ['__start'] : t.isGlobal ? ['__any'] : t.from.map((f) => f.ref);
    const target = t.to?.ref;
    for (const src of sources) {
      const a = all.get(src);
      const b = target ? all.get(target) : a;
      if (!a || !b) continue;
      const pk = [src, target].sort().join('|');
      const idx = pairCount.get(pk) || 0;
      pairCount.set(pk, idx + 1);
      const A = center(a);
      const B = center(b);
      let d;
      let lx;
      let ly;
      if (a === b) {
        // self loop above the node
        const x0 = a.x + a.w * 0.65;
        const y0 = a.y;
        d = `M${x0},${y0} C${x0 + 10},${y0 - 46} ${x0 - 50},${y0 - 46} ${x0 - 34},${y0}`;
        lx = x0 - 12;
        ly = y0 - 38;
      } else {
        const forward = b.x > a.x + 20;
        const backward = b.x < a.x - 20;
        const bend = (idx % 2 ? -1 : 1) * Math.ceil(idx / 2) * 26;
        if (forward) {
          const x1 = a.x + a.w;
          const y1 = A.cy + bend * 0.3;
          const x2 = b.x;
          const y2 = B.cy + bend * 0.3;
          const dx = Math.max(40, (x2 - x1) / 2);
          d = `M${x1},${y1} C${x1 + dx},${y1 + bend} ${x2 - dx},${y2 + bend} ${x2},${y2}`;
          lx = (x1 + x2) / 2;
          ly = (y1 + y2) / 2 + bend * 0.75;
        } else if (backward) {
          const x1 = A.cx;
          const y1 = a.y + a.h;
          const x2 = B.cx;
          const y2 = b.y + b.h;
          const drop = 44 + Math.abs(x1 - x2) * 0.12 + idx * 22;
          d = `M${x1},${y1} C${x1},${y1 + drop} ${x2},${y2 + drop} ${x2},${y2}`;
          lx = (x1 + x2) / 2;
          ly = Math.max(y1, y2) + drop * 0.75;
        } else {
          const down = b.y > a.y;
          const x1 = A.cx + bend;
          const y1 = down ? a.y + a.h : a.y;
          const x2 = B.cx + bend;
          const y2 = down ? b.y : b.y + b.h;
          const side = 60 + idx * 24;
          d = `M${x1},${y1} C${x1 + side},${y1 + (down ? 20 : -20)} ${x2 + side},${y2 + (down ? -20 : 20)} ${x2},${y2}`;
          lx = (x1 + x2) / 2 + side * 0.75;
          ly = (y1 + y2) / 2;
        }
      }
      const text = truncate(t.name, 26);
      edges.push({
        key: `${t.key}|${src}`,
        tKey: t.key,
        from: src,
        to: target || src,
        d,
        dashed: t.isGlobal,
        app: t.thirdParty > 0,
        finding: findingKeys.has(t.key),
        label: { x: lx, y: ly, text, w: text.length * 6 + 14 },
      });
    }
  }

  // Labels of edges that share a corridor (e.g. several global transitions) can land on each
  // other – nudge each one vertically to the nearest free slot
  const placed = [];
  const hits = (l, y) => placed.some((p) => Math.abs(p.x - l.x) < (p.w + l.w) / 2 + 4 && Math.abs(p.y - y) < 22);
  for (const e of edges) {
    const l = e.label;
    let y = l.y;
    for (let k = 1; hits(l, y) && k <= 12; k++) y = l.y + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 22;
    l.y = y;
    placed.push(l);
  }

  // Bounding box
  const pts = [...all.values()].flatMap((n) => [[n.x, n.y], [n.x + n.w, n.y + n.h]]);
  for (const e of edges) pts.push([e.label.x - e.label.w / 2, e.label.y - 10], [e.label.x + e.label.w / 2, e.label.y + 10]);
  const bx0 = Math.min(...pts.map((p) => p[0])) - 30;
  const by0 = Math.min(...pts.map((p) => p[1])) - 30;
  const bx1 = Math.max(...pts.map((p) => p[0])) + 30;
  const by1 = Math.max(...pts.map((p) => p[1])) + 30;
  return { mode, hasJiraLayout, nodes: [...nodes.values()], virtual, edges, box: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Static SVG markup (exports). */
export function diagramSvg(layout, { anyLabel = 'Any status', dark = false } = {}) {
  const { box } = layout;
  const ink = dark ? '#e8e6e1' : '#262729';
  const bg = dark ? '#26272a' : '#ffffff';
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${Math.round(box.w)}" height="${Math.round(box.h)}" font-family="Segoe UI, Arial, sans-serif">`);
  parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8a8780"/></marker><marker id="arrO" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#E34B04"/></marker></defs>`);
  parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${bg}"/>`);
  for (const e of layout.edges) {
    const col = e.app ? '#E34B04' : '#8a8780';
    parts.push(`<path d="${e.d}" fill="none" stroke="${col}" stroke-width="1.4" ${e.dashed ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${e.app ? 'arrO' : 'arr'})"/>`);
  }
  for (const v of layout.virtual) {
    if (v.kind === 'start') parts.push(`<circle cx="${v.x + 9}" cy="${v.y + 9}" r="9" fill="${ink}"/>`);
    else parts.push(`<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" rx="14" fill="${bg}" stroke="${ink}" stroke-dasharray="4 3"/><text x="${v.x + v.w / 2}" y="${v.y + 18}" text-anchor="middle" font-size="11" fill="${ink}">${esc(anyLabel)}</text>`);
  }
  for (const n of layout.nodes) {
    const c = categoryColors(n.category);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/><text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="${c.ink}">${esc(n.label)}</text>`);
  }
  for (const e of layout.edges) {
    const l = e.label;
    parts.push(`<rect x="${l.x - l.w / 2}" y="${l.y - 9}" width="${l.w}" height="18" rx="3" fill="${bg}" stroke="${e.finding ? '#C9372C' : '#CAC6BB'}"/><text x="${l.x}" y="${l.y + 4}" text-anchor="middle" font-size="10.5" fill="${ink}">${esc(l.text)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
