/**
 * Live flow tab: issue counts and stale issues per status from Jira, with bottleneck and never-used-status
 * insights and a jump to the diagram load overlay.
 *
 * @file        static/app/src/components/Flow.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, StatusPill, Kpi, Skeleton } from './common.jsx';
import { loadInsights } from '../../../../src/shared/insights.js';
import Icon from './Icon.jsx';

export default function Flow({ model, workflows, load, loadState, fetchLoad }) {
  const t = useT();
  const { actions } = useApp();
  const [days, setDays] = useState(load?.staleDays || 30);
  const insights = useMemo(() => (load ? loadInsights(model, load) : []), [model, load]);

  if (model.kind === 'site') return <div className="card empty">{t('fl.projectOnly')}</div>;

  return (
    <div>
      <div className="card accent">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t('fl.title')}</h2>
          <div className="row">
            <label className="small muted" htmlFor="fl-days">{t('fl.staleAfter')}</label>
            <select id="fl-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t('fl.days', { n: d })}</option>)}
            </select>
            <button type="button" className="btn primary" disabled={loadState === 'loading'} onClick={() => fetchLoad(days)}><Icon name="refresh" />{load ? t('app.refresh') : t('fl.load')}</button>
            {load && <button type="button" className="btn dark" onClick={() => actions.showOverlay('load')}><Icon name="diagram" />{t('acc.showInDiagram')}</button>}
          </div>
        </div>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('fl.intro')}</p>
      </div>

      {loadState === 'loading' && (
        <div className="card stack" role="status">
          <span className="small muted">{t('fl.loading')}</span>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={36} />)}
        </div>
      )}
      {loadState === 'error' && <div className="alert error">{t('app.error')}</div>}

      {load && loadState !== 'loading' && (
        <>
          <div className="grid kpis" style={{ marginBottom: 14 }}>
            <Kpi value={load.all} label={t('fl.allIssues')} />
            <Kpi value={load.total} label={t('fl.openIssues')} accent />
            <Kpi value={Object.values(load.byStatus).reduce((a, s) => a + (s.stale || 0), 0)} label={t('fl.staleIssues', { n: load.staleDays })} />
            <Kpi value={insights.length} label={t('fl.insights')} />
          </div>

          {insights.length > 0 && (
            <div className="card">
              <h3>{t('fl.insights')}</h3>
              {insights.map((i, k) => (
                <div key={k} className="row" style={{ flexWrap: 'nowrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className={`sev ${i.severity}`}>{t(`fl.code.${i.code}`)}</span>
                  <div style={{ flex: 1 }}>{t(`li.${i.code}`, i)}<div className="small muted">{i.wfName}</div></div>
                </div>
              ))}
            </div>
          )}

          {workflows.map((wf) => {
            // This workflow's own issue types when the project uses several workflows
            const own = load.byWorkflow?.[wf.id];
            const byStatus = own?.byStatus || load.byStatus;
            // No issue of this workflow's issue types at all: nothing is "never used", there is simply no data yet
            const empty = own ? own.all === 0 : load.all === 0;
            const max = Math.max(1, ...wf.statuses.map((s) => byStatus[s.id]?.count || 0));
            return (
              <div key={wf.id} className="card">
                <h3>{wf.name}</h3>
                {empty && <p className="muted small">{t('fl.noIssues')}</p>}
                <table className="data">
                  <thead><tr><th>{t('ref.status')}</th><th style={{ width: '45%' }}>{t('fl.issues')}</th><th className="nowrap">{t('fl.count')}</th><th className="nowrap">{t('fl.stale')}</th></tr></thead>
                  <tbody>
                    {wf.statuses.map((s) => {
                      const l = byStatus[s.id] || { count: 0, stale: 0 };
                      const col = s.category === 'DONE' ? 'var(--ok)' : s.category === 'IN_PROGRESS' ? '#2f6fde' : '#8590a2';
                      return (
                        <tr key={s.ref}>
                          <td><StatusPill status={s} />{!empty && l.ever === 0 && <span className="chip warn" style={{ marginLeft: 6 }}>{t('fl.neverUsed')}</span>}</td>
                          <td>
                            <div className="bar" style={{ height: 12 }}>
                              <span style={{ width: `${(100 * l.count) / max}%`, background: col }} />
                              <span style={{ width: `${(100 * (l.stale || 0)) / max}%`, background: 'repeating-linear-gradient(45deg, var(--accent), var(--accent) 3px, transparent 3px, transparent 6px)', opacity: 0.8 }} />
                            </div>
                          </td>
                          <td><strong>{l.count}</strong></td>
                          <td style={{ color: l.stale ? 'var(--link)' : undefined, fontWeight: l.stale ? 500 : undefined }}>{l.stale || 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
          <div className="small muted">{t('fl.footnote', { date: t.date(load.at) })}</div>
        </>
      )}
    </div>
  );
}
