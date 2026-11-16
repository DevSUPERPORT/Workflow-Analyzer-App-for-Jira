/**
 * Export tab: choose content and language and download the workflow documentation as interactive HTML, branded
 * PDF, CSV or JSON. runExport is shared with the "export selection" action of the transitions table.
 *
 * @file        static/app/src/components/ExportPanel.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { buildHtmlExport } from '../lib/exportHtml.js';
import { buildPdf, preparePdfAssets } from '../lib/exportPdf.js';
import { transitionsCsv } from '../lib/exportCsv.js';
import { downloadBlob, downloadText, exportFilename } from '../lib/download.js';
import logoWhite from '../assets/superport-wordmark-white.png?inline';
import logoDark from '../assets/superport-wordmark-dark.png?inline';
import Icon from './Icon.jsx';

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

// Shared by the panel and the "export selection" action in the transitions table.
export function runExport(format, { model, workflows, notes, opts, assets }) {
  const fallback = workflows.length === 1 ? workflows[0].name : model.project?.key || 'Site';
  const filename = exportFilename({ customer: opts.customer, label: opts.label, fallback, ext: format });
  if (format === 'html') {
    downloadText(buildHtmlExport({ model, workflows, notes, opts, logo: logoWhite }), filename, 'text/html;charset=utf-8');
  } else if (format === 'pdf') {
    const doc = buildPdf({ model, workflows, notes, opts, assets, logoWhite, logoDark });
    downloadBlob(doc.output('blob'), filename);
  } else if (format === 'csv') {
    downloadText(transitionsCsv(model, workflows, opts.lang, notes, opts.onlyKeys ? new Set(opts.onlyKeys) : null), filename, 'text/csv;charset=utf-8');
  } else if (format === 'json') {
    const { index, ...rest } = model;
    downloadText(JSON.stringify({ ...rest, workflows, index }, null, 2), filename, 'application/json');
  }
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

  const go = (format) => {
    setBusy(format);
    try {
      const file = runExport(format, { model, workflows: targetWfs, notes, opts, assets });
      toast(t('ex.done', { file }));
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
