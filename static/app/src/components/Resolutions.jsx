/**
 * Issue resolution check and repair: lists Done issues without a resolution and open issues that still carry
 * one, suggests a resolution per status and repairs them in place (status unchanged), in batches,
 * compare-and-set, with an undo for every run.
 *
 * @file        static/app/src/components/Resolutions.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { call } from '../lib/api.js';
import { useApp, StatusPill, EmptyState, Skeleton } from './common.jsx';
import { suggestResolution } from '../../../../src/shared/autopilot.js';
import { openIssue } from './Remediate.jsx';
import Icon from './Icon.jsx';

const BATCH = 20;
const LIST_MAX = 1000;
const NONE = '';
const newRunId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 20);

/**
 * Issue resolution check and repair: issues in a Done status without a resolution and open issues that still carry
 * one. The workflow fix only helps future transitions; this repairs the existing issues in place (status unchanged),
 * in batches, compare-and-set, with an undo for every run.
 */
export default function Resolutions({ audit, refreshAudit, resolutions = [], siteUrl, open, setOpen }) {
  const t = useT();
  const { model, caps } = useApp();
  const site = model?.kind === 'site';
  const [kind, setKind] = useState(audit?.doneUnresolved || !audit?.openResolved ? 'doneUnresolved' : 'openResolved');
  const [list, setList] = useState(null); // { issues, nextPageToken }
  const [listState, setListState] = useState(null); // loading | error
  const [target, setTarget] = useState({}); // key -> resolution id ('' = none)
  const [selected, setSelected] = useState(new Set());
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState(null); // { id, total, done, results, undoOf, running }
  const [runs, setRuns] = useState(null);
  const panelRef = useRef(null);
  const runRef = useRef(null);
  const total = (audit?.doneUnresolved || 0) + (audit?.openResolved || 0);
  // Singular texts where the dictionary has them ("1 issue", not "1 issues")
  const tn = (key, n, vars = {}) => (n === 1 ? t(`${key}1`, vars) : t(key, { ...vars, n }));
  const resName = (id) => resolutions.find((r) => String(r.id) === String(id))?.name || id;

  const defaultTarget = (i) => (kind === 'openResolved' ? NONE : String(suggestResolution(i.status?.name || '', resolutions)?.id || NONE));

  // All affected issues are loaded up front (up to LIST_MAX), so "repair all" really means all of them
  const loadList = async (k = kind, token = null) => {
    setListState('loading');
    try {
      const got = [];
      let next = token;
      do {
        const page = await call('resolutionIssues', { kind: k, nextPageToken: next });
        got.push(...page.issues);
        next = page.nextPageToken;
      } while (next && got.length < LIST_MAX);
      setList((prev) => (token && prev ? { issues: [...prev.issues, ...got], nextPageToken: next } : { issues: got, nextPageToken: next }));
      setTarget((prev) => {
        const map = token ? { ...prev } : {};
        for (const i of got) if (!(i.key in map)) map[i.key] = k === 'openResolved' ? NONE : String(suggestResolution(i.status?.name || '', resolutions)?.id || NONE);
        return map;
      });
      setSelected((prev) => new Set([...(token ? prev : []), ...got.map((i) => i.key)]));
      setListState(null);
    } catch {
      setListState('error');
    }
  };
  const loadRuns = () => call('resolutionRuns').then(setRuns).catch(() => setRuns([]));
  // The history (and its Undo) must stay reachable when nothing is left to repair
  useEffect(() => { loadRuns(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    loadList(kind);
    loadRuns();
    panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  // Nothing left in this list but the other one has issues: go there (the lazy path through both checks)
  const other = kind === 'doneUnresolved' ? 'openResolved' : 'doneUnresolved';
  useEffect(() => {
    if (open && list && !list.issues.length && listState !== 'loading' && audit?.[other] > 0 && !run?.running) setKind(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, audit]);

  const issues = list?.issues || [];
  const chosen = issues.filter((i) => selected.has(i.key));
  // Done issues must get a resolution; open issues get theirs cleared
  const valid = (i) => (kind === 'doneUnresolved' ? !!target[i.key] : true);
  const ready = chosen.filter(valid);
  const allOn = issues.length > 0 && issues.every((i) => selected.has(i.key));

  const execute = async (items, { undoOf = null, label } = {}) => {
    const id = newRunId();
    const results = [];
    setConfirming(false);
    setRun({ id, total: items.length, done: 0, results, undoOf, running: true, label });
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const res = await call('resolutionRepair', { items: items.slice(i, i + BATCH), runId: id, kind, undoOf });
        results.push(...res.results);
        setRun({ id, total: items.length, done: Math.min(i + BATCH, items.length), results: [...results], undoOf, running: true, label, silent: res.silent });
      }
    } catch (e) {
      results.push(...items.slice(results.length).map((it) => ({ ...it, status: 'failed', code: 'FAILED', message: e.message })));
    }
    setRun((r) => ({ ...r, results: [...results], done: items.length, running: false }));
    refreshAudit?.();
    loadRuns();
    await loadList(kind);
    // The list shrinks after a repair: bring the result into view once the layout has settled
    requestAnimationFrame(() => runRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
    return results.filter((r) => r.status === 'repaired').length;
  };

  const repair = () => execute(ready.map((i) => ({ key: i.key, from: i.resolution?.id || null, to: target[i.key] || null })), { label: kind });
  const undo = (items, undoOf) => execute(items.map((i) => ({ key: i.key, from: i.to, to: i.from })), { undoOf, label: 'undo' });

  const counts = useMemo(() => {
    const c = { repaired: 0, skipped: 0, failed: 0 };
    for (const r of run?.results || []) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [run]);
  const failures = (run?.results || []).filter((r) => r.status === 'failed');

  if (!audit) {
    return (
      <section className="card stack" aria-busy="true" aria-label={t('rs.title')}>
        <Skeleton w="40%" h={16} />
        <Skeleton h={12} />
      </section>
    );
  }

  return (
    <section className="card rs" ref={panelRef} aria-labelledby="rs-title">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <h2 id="rs-title" style={{ margin: 0 }}>{t('rs.title')}</h2>
          <p className="muted small" style={{ margin: '4px 0 0', maxWidth: '72ch' }}>{site ? t('rs.introSite') : t('rs.intro')}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {total > 0 && !open && <button type="button" className="btn primary" onClick={() => setOpen(true)}><Icon name="wand" />{t('rs.review')}</button>}
          {total === 0 && !open && runs?.length > 0 && <button type="button" className="btn small" onClick={() => setOpen(true)}><Icon name="history" />{t('rs.history', { n: runs.length })}</button>}
          {open && <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>{t('rs.close')}</button>}
          <button type="button" className="btn small ghost only" onClick={() => refreshAudit?.()} aria-label={t('app.refresh')} title={t('app.refresh')}><Icon name="refresh" /></button>
        </div>
      </div>

      <div className="rs-counts" role="group" aria-label={t('rs.title')}>
        {['doneUnresolved', 'openResolved'].map((k) => (
          <button key={k} type="button" className={`rs-count ${audit[k] ? 'bad' : 'good'} ${open && kind === k ? 'on' : ''}`} aria-pressed={open && kind === k} onClick={() => { setKind(k); setOpen(true); }} disabled={!audit[k] && !(open && kind === k)}>
            <span className="num">{audit[k]}</span>
            <span className="l">{t(`rs.kind.${k}`)}</span>
            <span className="s">{t(`rs.why.${k}`)}</span>
          </button>
        ))}
      </div>

      {total === 0 && !open && !run && <EmptyState icon="check" title={t('rs.clean')} />}

      {run && (
        <div ref={runRef} className={`alert ${run.running ? 'info' : counts.failed ? 'error' : 'ok'} rs-run`} role="status" aria-live="polite">
          <Icon name={run.running ? 'refresh' : counts.failed ? 'alert' : 'check'} size={18} style={run.running ? { animation: 'spin 0.9s linear infinite' } : undefined} />
          <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
            <strong>{run.running ? t('rs.running', { done: run.done, total: run.total }) : run.label === 'undo' ? tn('rs.undone', counts.repaired) : tn('rs.doneMsg', counts.repaired)}</strong>
            {run.running && <div className="bar" aria-hidden="true"><span style={{ width: `${(100 * run.done) / Math.max(1, run.total)}%`, transition: 'width 300ms var(--ease)' }} /></div>}
            {!run.running && (counts.skipped > 0 || counts.failed > 0) && <span className="small">{t('rs.summary', counts)}</span>}
            {failures.length > 0 && (
              <ul className="small rs-fail">
                {failures.slice(0, 8).map((f) => <li key={f.key}><strong>{f.key}</strong> · {t(`rs.err.${f.code}`) !== `rs.err.${f.code}` ? t(`rs.err.${f.code}`) : f.message}</li>)}
                {failures.length > 8 && <li>{t('rs.more', { n: failures.length - 8 })}</li>}
              </ul>
            )}
          </div>
          {!run.running && run.label !== 'undo' && counts.repaired > 0 && run.results.filter((r) => r.status === 'repaired').every((r) => !r.to) && (
            <button type="button" className="btn small" onClick={() => undo(run.results.filter((r) => r.status === 'repaired'), run.id)}><Icon name="undo" />{t('rs.undo')}</button>
          )}
          {!run.running && <button type="button" className="btn small ghost only" aria-label={t('app.dismiss')} onClick={() => setRun(null)}><Icon name="x" /></button>}
        </div>
      )}

      {open && (
        <div className="stack" style={{ gap: 12 }}>
          {listState === 'error' && <div className="alert error"><Icon name="alert" size={18} /><span style={{ flex: 1 }}>{t('app.error')}</span><button type="button" className="btn small" onClick={() => loadList(kind)}>{t('app.retry')}</button></div>}
          {!list && listState === 'loading' && <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={34} />)}</div>}
          {list && issues.length === 0 && <EmptyState icon="check" title={t(`rs.none.${kind}`)} />}
          {issues.length > 0 && (
            <>
              <div className="toolbar rs-bar">
                <label className="row small" style={{ gap: 8 }}>
                  <input type="checkbox" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(issues.map((i) => i.key)))} />
                  {t('rs.selected', { n: chosen.length, total: issues.length })}
                </label>
                {kind === 'doneUnresolved' && resolutions.length > 0 && (
                  <label className="row small" style={{ gap: 6 }}>
                    {t('rs.setAll')}
                    <select value="" onChange={(e) => { const v = e.target.value; if (!v) return; setTarget((p) => { const n = { ...p }; for (const i of chosen) n[i.key] = v === '@suggest' ? defaultTarget(i) : v; return n; }); }}>
                      <option value="">{t('rs.choose')}</option>
                      <option value="@suggest">{t('rs.suggested')}</option>
                      {resolutions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="table-wrap">
                <table className="data rs-table">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}><span className="sr-only">{t('rs.select')}</span></th>
                      <th>{t('rs.issue')}</th>
                      <th>{t('ref.status')}</th>
                      <th>{t('rs.now')}</th>
                      <th>{t('rs.new')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.key} className={selected.has(i.key) ? 'on' : ''}>
                        <td><input type="checkbox" aria-label={i.key} checked={selected.has(i.key)} onChange={() => setSelected((p) => { const n = new Set(p); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); return n; })} /></td>
                        <td style={{ minWidth: 0 }}>
                          <button type="button" className="link-btn" onClick={() => openIssue(siteUrl, i.key)} title={t('rs.openIssue')}><strong>{i.key}</strong><Icon name="external" size={12} /></button>
                          <div className="small muted clamp-1" title={i.summary}>{i.summary}{site && i.project ? ` · ${i.project.name}` : ''}</div>
                          <div className="rs-inline-status"><StatusPill status={{ name: i.status?.name, category: i.status?.category }} /></div>
                        </td>
                        <td><StatusPill status={{ name: i.status?.name, category: i.status?.category }} /></td>
                        <td className="small">{i.resolution ? i.resolution.name : <span className="muted">{t('rs.unresolved')}</span>}</td>
                        <td>
                          {kind === 'doneUnresolved' ? (
                            <select aria-label={t('rs.newFor', { key: i.key })} value={target[i.key] ?? ''} onChange={(e) => setTarget((p) => ({ ...p, [i.key]: e.target.value }))}>
                              <option value="">{t('rs.choose')}</option>
                              {resolutions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                          ) : <span className="small muted">{t('rs.clear')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list?.nextPageToken && <button type="button" className={`btn small ${listState === 'loading' ? 'busy' : ''}`} disabled={listState === 'loading'} onClick={() => loadList(kind, list.nextPageToken)}>{t('rs.loadMore')}</button>}

              <p className="small muted" style={{ margin: 0 }}><Icon name="info" size={13} /> {kind === 'openResolved' ? t('rs.noteClear') : caps?.jiraAdmin ? t('rs.noteSetAdmin') : t('rs.noteSetProject')}</p>
              {!confirming ? (
                <div className="row">
                  <button type="button" className="btn primary" disabled={!ready.length || run?.running} onClick={() => setConfirming(true)}>
                    <Icon name="wand" />{kind === 'doneUnresolved' ? tn('rs.repairSet', ready.length) : tn('rs.repairClear', ready.length)}
                  </button>
                  {chosen.length > ready.length && <span className="small muted">{tn('rs.missingChoice', chosen.length - ready.length)}</span>}
                </div>
              ) : (
                <div className="confirm" role="alertdialog" aria-label={(kind === 'doneUnresolved' ? tn('rs.confirmSet', ready.length) : tn('rs.confirmClear', ready.length))}>
                  <Icon name="play" size={16} />
                  <span className="small">{(kind === 'doneUnresolved' ? tn('rs.confirmSet', ready.length) : tn('rs.confirmClear', ready.length))}</span>
                  <button type="button" className="btn small primary" autoFocus onClick={repair}>{t('rs.confirmYes')}</button>
                  <button type="button" className="btn small" onClick={() => setConfirming(false)}>{t('ap.confirmNo')}</button>
                </div>
              )}
            </>
          )}

          {runs?.length > 0 && (
            <details className="rs-history" open={!issues.length || undefined}>
              <summary className="small">{t('rs.history', { n: runs.length })}</summary>
              <ul className="small">
                {runs.map((r) => (
                  <li key={r.id} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span>
                      {t.date(r.at)} · {r.by || '–'} · {r.undoOf ? tn('rs.histUndo', r.items.length) : tn('rs.histRun', r.items.length)}
                      {r.items.length > 0 && <span className="muted"> ({r.items.slice(0, 3).map((i) => `${i.key} → ${i.to ? resName(i.to) : t('rs.unresolved')}`).join(', ')}{r.items.length > 3 ? ' …' : ''})</span>}
                    </span>
                    {!r.undoOf && !r.undoneBy && r.items.length > 0 && r.items.every((i) => !i.to) && <button type="button" className="btn small ghost" disabled={run?.running} onClick={() => undo(r.items, r.id)}><Icon name="undo" />{t('rs.undo')}</button>}
                    {r.undoneBy && <span className="chip small-chip">{t('rs.wasUndone')}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
