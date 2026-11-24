/**
 * Interactive workflow diagram with pan, zoom, fit and path highlighting, plus overlays for issue load, persona
 * access and impact. The live view follows the Jira theme; SVG, PNG and Mermaid exports keep the fixed palette
 * of diagram.js.
 *
 * @file        static/app/src/components/Diagram.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from './common.jsx';
import { layoutWorkflow, diagramSvg } from '../../../../src/shared/diagram.js';

// Live view follows the theme (light/dark); exported SVG/PNG/PDF keep the fixed palette of diagram.js
const LIVE_CAT = {
  TODO: { fill: 'var(--cat-todo)', stroke: 'var(--border-strong)', ink: 'var(--cat-todo-ink)' },
  IN_PROGRESS: { fill: 'var(--cat-progress)', stroke: 'var(--cat-progress-ink)', ink: 'var(--cat-progress-ink)' },
  DONE: { fill: 'var(--cat-done)', stroke: 'var(--cat-done-ink)', ink: 'var(--cat-done-ink)' },
};
import { toMermaid } from '../../../../src/shared/insights.js';
import { svgToPng, dataUrlToBlob } from '../lib/exportPdf.js';
import { downloadText, downloadBlob, exportFilename } from '../lib/download.js';
import Icon from './Icon.jsx';

export default function Diagram({ wf, model, overlay = {}, setOverlayMode = () => {}, toast }) {
  const t = useT();
  const { actions } = useApp();
  const findingKeys = useMemo(() => new Set(model.findings.filter((f) => f.tKey && f.severity !== 'info').map((f) => f.tKey)), [model]);
  const [mode, setMode] = useState('jira');
  const layout = useMemo(() => layoutWorkflow(wf, { mode, findingKeys }), [wf, mode, findingKeys]);
  const [view, setView] = useState(layout.box);
  const [focus, setFocus] = useState(null);
  const drag = useRef(null);
  const svgRef = useRef(null);

  // Readable default zoom (≥ 0.8 px per unit), anchored left; "Fit" shows everything.
  const readableView = () => {
    const box = layout.box;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return box;
    const scale = Math.min(rect.width / box.w, rect.height / box.h);
    if (scale >= 0.8) return box;
    const w = rect.width / 0.8;
    const h = rect.height / 0.8;
    return { x: box.x, y: box.y + box.h / 2 - h / 2, w, h };
  };

  useEffect(() => {
    setView(readableView());
    setFocus(null);
  }, [layout]);

  const zoom = (f) => setView((v) => ({ x: v.x + (v.w * (1 - f)) / 2, y: v.y + (v.h * (1 - f)) / 2, w: v.w * f, h: v.h * f }));

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.15 : 0.87);
  };
  const onDown = (e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view };
  };
  const onMove = (e) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = Math.max(drag.current.view.w / rect.width, drag.current.view.h / rect.height);
    setView({ ...drag.current.view, x: drag.current.view.x - (e.clientX - drag.current.x) * scale, y: drag.current.view.y - (e.clientY - drag.current.y) * scale });
  };
  const onUp = () => { drag.current = null; };

  const related = (e) => !focus || e.from === focus || e.to === focus;
  const ovMode = overlay.mode || 'none';
  const edgeStyle = (e) => {
    if (ovMode === 'persona' && overlay.sim) {
      const s = overlay.sim[e.tKey]?.state;
      return { stroke: s === 'yes' ? 'var(--ok)' : s === 'no' ? 'var(--high)' : 'var(--accent)', strokeWidth: s === 'no' ? 1.2 : 2.4, opacity: s === 'no' ? 0.35 : 1 };
    }
    if (ovMode === 'impact' && overlay.impact) return overlay.impact.has(e.tKey) ? { stroke: 'var(--accent)', strokeWidth: 3.2 } : { opacity: 0.15 };
    return undefined;
  };
  const fname = (ext) => exportFilename({ label: wf.name, fallback: wf.name, ext });
  const exportSvg = () => downloadText(diagramSvg(layoutWorkflow(wf, { mode: layout.mode, findingKeys }), { anyLabel: t('dg.any') }), fname('svg'), 'image/svg+xml');
  // No fetch() of the data: URL here – Forge's CSP blocks it and the button silently did nothing
  const exportPng = async () => {
    try {
      const img = await svgToPng(diagramSvg(layoutWorkflow(wf, { mode: layout.mode, findingKeys }), { anyLabel: t('dg.any') }));
      if (!img) throw new Error('PNG rendering failed');
      downloadBlob(img.blob || dataUrlToBlob(img.data), fname('png'));
    } catch (e) {
      console.error('[diagram] PNG export failed', e);
      toast?.(t('dg.pngFailed'));
    }
  };
  const exportMermaid = () => {
    const text = toMermaid(wf);
    try { navigator.clipboard?.writeText(text); } catch { /* clipboard may be blocked in iframes */ }
    downloadText(text, fname('mmd'));
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted small" style={{ flex: 1 }}>{t('dg.hint')}</span>
        <label className="small muted" htmlFor="dg-overlay">{t('dg.overlay')}</label>
        <select id="dg-overlay" value={ovMode} onChange={(e) => setOverlayMode(e.target.value)}>
          <option value="none">{t('dg.ov.none')}</option>
          <option value="load" disabled={!overlay.load}>{t('dg.ov.load')}{overlay.load ? '' : ` (${t('dg.ov.loadFirst')})`}</option>
          <option value="persona">{t('dg.ov.persona')}</option>
          <option value="impact" disabled={!overlay.impact}>{t('dg.ov.impact')}{overlay.impactLabel ? `: ${overlay.impactLabel}` : ''}</option>
        </select>
        <button type="button" className="btn small" onClick={exportSvg} title={t('dg.export')}><Icon name="download" />SVG</button>
        <button type="button" className="btn small" onClick={exportPng} title={t('dg.export')}><Icon name="download" />PNG</button>
        <button type="button" className="btn small" onClick={exportMermaid} title={t('dg.mermaidHint')}><Icon name="download" />Mermaid</button>
        {layout.hasJiraLayout && (
          <div className="seg" role="group" aria-label={t('dg.layoutJira')} style={{ height: 'var(--h-sm)' }}>
            <button type="button" aria-pressed={layout.mode === 'jira'} onClick={() => setMode('jira')}>{t('dg.layoutJira')}</button>
            <button type="button" aria-pressed={layout.mode === 'auto'} onClick={() => setMode('auto')}>{t('dg.layoutAuto')}</button>
          </div>
        )}
      </div>
      <div className="diagram-wrap">
        <div className="diagram-tools">
          <button type="button" className="btn small" onClick={() => zoom(0.8)} title={t('dg.zoomIn')} aria-label={t('dg.zoomIn')}><Icon name="zoomIn" /></button>
          <button type="button" className="btn small" onClick={() => zoom(1.25)} title={t('dg.zoomOut')} aria-label={t('dg.zoomOut')}><Icon name="zoomOut" /></button>
          <button type="button" className="btn small" onClick={() => { setView(layout.box); setFocus(null); }}><Icon name="fit" />{t('dg.fit')}</button>
        </div>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMinYMid meet"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onWheel={onWheel}
          role="img"
          aria-label={wf.name}
        >
          <defs>
            <marker id="dg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--text-faint)" /></marker>
            <marker id="dg-arr-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
          </defs>
          {layout.edges.map((e) => (
            <g key={e.key} className={`dg-edge ${e.app ? 'app' : ''} ${related(e) ? (focus ? 'hot' : '') : 'dim'}`}>
              <path d={e.d} strokeDasharray={e.dashed ? '5 4' : undefined} markerEnd={`url(#${e.app ? 'dg-arr-o' : 'dg-arr'})`} style={edgeStyle(e)} />
            </g>
          ))}
          {layout.virtual.map((v) =>
            v.kind === 'start' ? (
              <circle key={v.ref} cx={v.x + 9} cy={v.y + 9} r="9" fill="var(--text)" />
            ) : (
              <g key={v.ref} className="dg-node" onClick={() => setFocus(focus === v.ref ? null : v.ref)}>
                <rect x={v.x} y={v.y} width={v.w} height={v.h} rx="14" fill="var(--surface)" stroke="var(--text)" strokeDasharray="4 3" />
                <text x={v.x + v.w / 2} y={v.y + 18} textAnchor="middle" fontSize="11" fill="var(--text)" style={{ fontWeight: 400 }}>{t('dg.any')}</text>
              </g>
            ),
          )}
          {layout.nodes.map((n) => {
            const c = LIVE_CAT[n.category] || LIVE_CAT.TODO;
            const dim = focus && focus !== n.ref && !layout.edges.some((e) => (e.from === focus && e.to === n.ref) || (e.to === focus && e.from === n.ref));
            return (
              <g key={n.ref} className={`dg-node ${dim ? 'dim' : ''}`} onClick={() => setFocus(focus === n.ref ? null : n.ref)}>
                <title>{n.name}</title>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8" fill={c.fill} strokeOpacity={focus === n.ref ? 1 : 0.55} stroke={focus === n.ref ? 'var(--accent)' : c.stroke} strokeWidth={focus === n.ref ? 3 : 1.5} />
                <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle" fill={c.ink}>{n.label}</text>
                {ovMode === 'load' && overlay.load?.byStatus?.[n.id] && (
                  <g>
                    <circle cx={n.x + n.w} cy={n.y} r={13} fill="var(--tile)" />
                    <text x={n.x + n.w} y={n.y + 4} textAnchor="middle" fill="var(--tile-text)" style={{ fontSize: 11 }}>{overlay.load.byStatus[n.id].count}</text>
                    {overlay.load.byStatus[n.id].stale > 0 && (
                      <g>
                        <circle cx={n.x + n.w - 26} cy={n.y} r={11} fill="var(--accent)" />
                        <text x={n.x + n.w - 26} y={n.y + 4} textAnchor="middle" fill="#fff" style={{ fontSize: 10 }}>{overlay.load.byStatus[n.id].stale}</text>
                      </g>
                    )}
                  </g>
                )}
              </g>
            );
          })}
          {layout.edges.map((e) => (
            <g
              key={`l-${e.key}`}
              className={`dg-label ${e.finding ? 'finding' : ''}`}
              style={{ opacity: related(e) ? 1 : 0.12 }}
              onClick={(ev) => { ev.stopPropagation(); actions.openTransition(e.tKey); }}
            >
              <title>{e.label.text}</title>
              <rect x={e.label.x - e.label.w / 2} y={e.label.y - 9} width={e.label.w} height="18" rx="3" />
              <text x={e.label.x} y={e.label.y + 4} textAnchor="middle">{e.label.text}</text>
            </g>
          ))}
        </svg>
        <div className="diagram-legend">
          {ovMode === 'load' && <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: 'var(--text)' }} /> {t('dg.ov.loadLegend')} <span className="dot" /> {t('fl.stale')}</span>}
          {ovMode === 'persona' && <span className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: 'var(--ok)' }} /> {t('acc.yes')} <span className="swatch" style={{ background: 'var(--high)' }} /> {t('acc.no')} <span className="swatch" style={{ background: 'var(--accent)' }} /> {t('acc.maybe')}</span>}
          <span><span className="status TODO">{t('cat.TODO')}</span></span>
          <span><span className="status IN_PROGRESS">{t('cat.IN_PROGRESS')}</span></span>
          <span><span className="status DONE">{t('cat.DONE')}</span></span>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" strokeWidth="2" /></svg> {t('dg.legendApp')}</span>
          <span><svg width="22" height="12"><rect x="1" y="1" width="20" height="10" rx="2" fill="none" stroke="var(--high)" strokeWidth="1.5" /></svg> {t('dg.legendFinding')}</span>
          <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--text-faint)" strokeWidth="1.5" strokeDasharray="5 4" /></svg> {t('tt.global').split(' (')[0]}</span>
        </div>
      </div>
    </div>
  );
}
