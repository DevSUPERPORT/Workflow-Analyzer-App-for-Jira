/**
 * Export tab: choose content and language and download the workflow documentation as interactive HTML, branded
 * PDF, CSV or JSON. runExport is shared with the "export selection" action of the transitions table.
 *
 * @file        static/app/src/components/ExportPanel.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { buildHtmlExport } from '../lib/exportHtml.js';
import { buildPdf, preparePdfAssets } from '../lib/exportPdf.js';
import { transitionsCsv } from '../lib/exportCsv.js';
import { downloadBlob, exportFilename } from '../lib/download.js';
import logoWhite from '../assets/superport-wordmark-white.png?inline';
import logoDark from '../assets/superport-wordmark-dark.png?inline';
import Icon from './Icon.jsx';
import { workflowStory, siteStory, exportGlossary, exportScope } from '../../../../src/shared/story.js';

const PREF = 'superport.wfa.export';

function loadPref() {
  try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; }
}

export function defaultExportOpts(lang) {
  const p = loadPref();
  return {
    lang,
    customer: p.customer || '',
    label: '',
    scope: 'all',
    include: { diagram: true, transitions: true, impact: true, health: true, explain: true, notes: true, ...(p.include || {}) },
  };
}

/** Builds an export file: { blob, filename }. */
export function buildExport(format, { model, workflows, notes, opts, assets }) {
  const fallback = workflows.length === 1 ? workflows[0].name : model.project?.key || 'Site';
  const filename = exportFilename({ customer: opts.customer, label: opts.label, fallback, ext: format });
  const text = (s, type) => ({ blob: new Blob([s], { type }), filename });
  if (format === 'html') return text(buildHtmlExport({ model, workflows, notes, opts, logo: logoWhite }), 'text/html;charset=utf-8');
  if (format === 'pdf') return { blob: buildPdf({ model, workflows, notes, opts, assets, logoWhite, logoDark }).output('blob'), filename };
  if (format === 'csv') return text(transitionsCsv(model, workflows, opts.lang, notes, opts.onlyKeys ? new Set(opts.onlyKeys) : null), 'text/csv;charset=utf-8');
  const { index, ...rest } = model;
  // The plain-language guide next to the raw analysis, so scripts and BI tools get the same explanations
  const scoped = { ...model, findings: exportScope(model, workflows, opts.onlyKeys).findings };
  const guide = { site: siteStory(scoped, opts.lang), workflows: workflows.map((wf) => workflowStory(scoped, wf, opts.lang)), glossary: exportGlossary(opts.lang) };
  return text(JSON.stringify({ ...rest, workflows, index, guide }, null, 2), 'application/json');
}

/** Browsers only allow a download shortly after the click: builds slower than this are saved with a second click. */
export const SLOW_EXPORT_MS = 3000;

// Shared by the panel and the "export selection" action in the transitions table.
export function runExport(format, args) {
  const { blob, filename } = buildExport(format, args);
  downloadBlob(blob, filename);
  return filename;
}

export default function ExportPanel({ model, workflows, allWorkflows, notes, toast }) {
  const t = useT();
  const [opts, setOpts] = useState(() => defaultExportOpts(t.lang));
  const [assets, setAssets] = useState(null);
  const [busy, setBusy] = useState(null);
  const targetWfs = opts.scope === 'current' ? workflows : allWorkflows;

  useEffect(() => {
    try { localStorage.setItem(PREF, JSON.stringify({ customer: opts.customer, include: opts.include })); } catch { /* ignore */ }
  }, [opts.customer, opts.include]);

  useEffect(() => {
    let alive = true;
    setAssets(null);
    preparePdfAssets(model, targetWfs, opts.lang).then((a) => alive && setAssets(a));
    return () => { alive = false; };
  }, [model, targetWfs.length, opts.scope, opts.lang]);

  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));
  const setInc = (k) => setOpts((o) => ({ ...o, include: { ...o.include, [k]: !o.include[k] } }));

  const [ready, setReady] = useState(null);
  const save = (file) => {
    downloadBlob(file.blob, file.filename);
    setReady(null);
    toast(t('ex.done', { file: file.filename }));
  };
  const go = async (format) => {
    setBusy(format);
    setReady(null);
    // Let "Generating …" paint before a long synchronous build (large sites)
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    try {
      const file = buildExport(format, { model, workflows: targetWfs, notes, opts, assets });
      const ms = Date.now() - started;
      console.debug(`[export] ${format} built in ${ms} ms`);
      if (ms > SLOW_EXPORT_MS) setReady({ ...file, format });
      else save(file);
    } catch (e) {
      console.error(e);
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  const cards = [
    { f: 'html', hint: 'ex.htmlHint', primary: true },
    { f: 'pdf', hint: 'ex.pdfHint', primary: true, needsAssets: true },
    { f: 'csv', hint: 'ex.csvHint' },
    { f: 'json', hint: 'ex.jsonHint' },
  ];

  return (
    <div>
      <div className="card accent">
        <h2 style={{ marginTop: 0 }}>{t('ex.title')}</h2>
        <p className="muted">{t('ex.intro')}</p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ex-customer">{t('ex.customer')} <span className="hint">({t('ex.customerHint')})</span></label>
            <input id="ex-customer" type="text" value={opts.customer} maxLength={20} placeholder="SCS, APG …" onChange={(e) => set({ customer: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ex-label">{t('ex.label')} <span className="hint">({t('ex.labelHint')})</span></label>
            <input id="ex-label" type="text" value={opts.label} maxLength={120} placeholder="IT Change Management Workflow v1.0" onChange={(e) => set({ label: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ex-lang">{t('ex.lang')}</label>
            <select id="ex-lang" value={opts.lang} onChange={(e) => set({ lang: e.target.value })}>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-scope">{t('ex.scope')}</label>
            <select id="ex-scope" value={opts.scope} onChange={(e) => set({ scope: e.target.value })}>
              <option value="all">{t('ex.scopeAll')} ({allWorkflows.length})</option>
              <option value="current" disabled={workflows.length === allWorkflows.length}>{t('ex.scopeCurrent')}{workflows.length === 1 ? `: ${workflows[0].name}` : ''}</option>
            </select>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>{t('ex.include')}</label>
          <div className="checks">
            {['diagram', 'transitions', 'impact', 'health', 'explain', 'notes'].map((k) => (
              <label key={k}><input type="checkbox" checked={opts.include[k]} onChange={() => setInc(k)} /> {t(`ex.inc${k[0].toUpperCase()}${k.slice(1)}`)}</label>
            ))}
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          {exportFilename({ customer: opts.customer, label: opts.label, fallback: targetWfs.length === 1 ? targetWfs[0].name : model.project?.key || 'Site', ext: 'html' })}
        </div>
      </div>
      {ready && (
        <div className="alert info view" role="status">
          <Icon name="download" size={18} />
          <span style={{ flex: 1 }}>{t('ex.ready', { file: ready.filename })}</span>
          <button type="button" className="btn primary small" onClick={() => save(ready)}>{t('ex.save')}</button>
        </div>
      )}
      <div className="export-grid">
        {cards.map((c) => (
          <div key={c.f} className="export-card">
            <div className="fmt" style={{ color: c.primary ? 'var(--link)' : 'var(--text)' }}>{c.f.toUpperCase()}</div>
            <div className="small muted" style={{ flex: 1 }}>{t(c.hint)}</div>
            <button type="button" className={`btn ${c.primary ? 'primary' : ''}`} disabled={!!busy || (c.needsAssets && !assets)} onClick={() => go(c.f)}>
              <Icon name="download" />{busy === c.f || (c.needsAssets && !assets) ? t('ex.generating') : t(`ex.${c.f}`)}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
