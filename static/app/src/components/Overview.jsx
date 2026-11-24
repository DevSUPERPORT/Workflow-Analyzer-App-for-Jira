/**
 * Overview tab: health score tile, KPIs (workflows, rules, dependencies, apps), the prioritised action plan (P1-P3)
 * next to the health check per area, workflows and issue types, and the apps and vendors used in rules.
 *
 * @file        static/app/src/components/Overview.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-23
 */

import { useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, Kpi, ScoreRing, scoreLabelKey, VendorBadge, EmptyState, rowAction } from './common.jsx';
import Icon from './Icon.jsx';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import { governance, actionPlan } from '../../../../src/shared/insights.js';
import { healthScore } from '../../../../src/shared/engine.js';

const START_HINT = 'superport.wfa.startHintHidden';

const tone = (score) => (score >= 80 ? 'var(--ok)' : score >= 55 ? 'var(--accent)' : 'var(--high)');

/** "1 critical · 3 warnings · 2 hints" – only the severities that occur, singular/plural per language. */
export function sevCounts(t, c) {
  return ['high', 'medium', 'low'].filter((k) => c[k] > 0).map((k) => t(c[k] === 1 ? `ov.n.${k}1` : `ov.n.${k}`, { n: c[k] })).join(' · ');
}

export default function Overview({ model, workflows }) {
  const t = useT();
  const { actions, caps } = useApp();
  const s = model.stats;
  const apps = model.vendors.filter((v) => v.thirdParty);
  const maxApp = Math.max(1, ...apps.map((a) => a.total));
  const plan = actionPlan(model);
  const rules = s.condition + s.validator + s.postfunction;
  const gov = governance(model);
  // Dependencies: the configuration objects the rules reference (apps have their own tile)
  const depTypes = REF_TYPES.filter((rt) => rt !== 'app' && s.refs[rt]);
  const deps = depTypes.reduce((n, rt) => n + s.refs[rt], 0);
  const depsMissing = depTypes.reduce((n, rt) => n + Object.values(model.index[rt] || {}).filter((e) => e.resolved === false || e.inactive).length, 0);
  const depsSub = [...depTypes.map((rt) => `${s.refs[rt]} ${t(`refs.${rt}`)}`), ...(depsMissing ? [`${depsMissing} ${t('im.unresolved')}`] : [])].join(' · ');
  // Where to start: shown until the person dismisses it (per browser)
  const [startHint, setStartHint] = useState(() => { try { return localStorage.getItem(START_HINT) !== '1'; } catch { return false; } });
  const hideStartHint = () => { try { localStorage.setItem(START_HINT, '1'); } catch { /* ignore */ } setStartHint(false); };

  return (
    <div>
      {startHint && (
        <div className="alert info row" role="note" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <Icon name="book" size={18} />
          <span style={{ flex: 1, minWidth: 220 }}><strong>{t('ov.start.title')}</strong> {t('ov.start.text')}</span>
          <button type="button" className="btn small primary" onClick={() => actions.startTour()}>{t('ov.start.tour')}</button>
          <button type="button" className="btn small" onClick={() => actions.setTab('guide')}>{t('ov.start.guide')}</button>
          <button type="button" className="btn small ghost" onClick={hideStartHint} aria-label={t('ov.start.hide')} title={t('ov.start.hide')}><Icon name="x" size={14} /></button>
        </div>
      )}
      <section className="grid kpis" aria-label={t('ov.health')}>
        <button type="button" className="tile ink" onClick={() => actions.goHealth('all')} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <ScoreRing score={s.healthScore} size={72} inverted />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span className="l">{t('ov.health')}</span>
            <span style={{ fontSize: 18, fontWeight: 500 }}>{t(scoreLabelKey(s.healthScore))}</span>
            <span className="s">{sevCounts(t, s.findings) || t('ov.scoreGood')}</span>
          </span>
        </button>
        <Kpi value={s.workflows} label={t('ov.workflows')} sub={`${s.statuses} ${t('ov.statuses')} · ${s.transitions} ${t('ov.transitions')}`} onClick={() => actions.setTab('transitions')} />
        <Kpi value={rules} label={t('ov.rules')} sub={`${s.condition} ${t('ov.conditions')} · ${s.validator} ${t('ov.validators')} · ${s.postfunction} ${t('ov.postfunctions')}`} onClick={() => actions.setTab('transitions')} />
        <Kpi value={deps} label={t('tab.impact')} sub={depsSub || t('ov.depsNone')} onClick={() => actions.setTab('impact')} />
        <Kpi value={s.apps} label={t('ov.apps')} sub={`${s.thirdPartyRules} ${t('ov.thirdPartyRules')}`} onClick={() => actions.openRefType('app')} />
      </section>

      <div className="split" style={{ marginBottom: 20 }}>
        <section className="card main" style={{ marginBottom: 0 }} aria-labelledby="ov-plan">
          <div className="card-head">
            <h2 id="ov-plan">{t('plan.title')}</h2>
            {model.kind === 'project' && plan.length > 0 && caps.createTasks && (
              <button type="button" className="btn small" onClick={() => actions.openRemediation(plan.flatMap((p) => p.findings))}><Icon name="plus" />{t('plan.createTasks')}</button>
            )}
          </div>
          <p className="small muted" style={{ marginTop: -8 }}>{t('plan.intro')}</p>
          {plan.length === 0 && <EmptyState icon="check" title={t('ov.findingsNone')} />}
          {plan.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border)' }}>
              {plan.slice(0, 7).map((p) => (
                <li key={p.code} style={{ borderBottom: '1px solid var(--border)' }}>
                  <button type="button" className="plan-row" onClick={() => actions.focusHealth(p.code)}>
                    <span className={`sev ${p.severity}`}>{p.priority}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 500 }}>{t(`plan.action.${p.code}`)}</span>
                      <span className="small muted">{p.findings.length === 1 ? t('plan.affects1') : t('plan.affects', { n: p.findings.length })} · {t(`gov.${p.category}`)}</span>
                    </span>
                    <span className="small muted nowrap">{t('plan.effort')} <strong style={{ color: 'var(--text)' }}>{p.effort}</strong></span>
                    <Icon name="chevronRight" style={{ color: 'var(--text-muted)' }} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card side" style={{ marginBottom: 0 }} aria-labelledby="ov-gov">
          <h2 id="ov-gov">{t('tab.health')}</h2>
          <div className="stack" style={{ gap: 14 }}>
            {gov.map((g) => (
              <div key={g.key}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ minWidth: 0 }}>{t(`gov.${g.key}`)} <span className="small muted">· {t(`gov.${g.key}.hint`)}</span></span>
                  <strong className="num" style={{ flex: 'none' }}>{g.score}</strong>
                </div>
                <div className="bar"><span style={{ width: `${g.score}%`, background: tone(g.score) }} /></div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="row" style={{ gap: 6 }}>
            {['high', 'medium', 'low'].map((sev) => (
              <button key={sev} type="button" className="chip" onClick={() => actions.goHealth(sev)} style={{ background: `var(--${sev}-bg)` }}>
                <span className="dot" style={{ background: `var(--${sev})` }} />{t(`ov.severity.${sev}`)} <strong className="num">{s.findings[sev]}</strong>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="ov-wfs">
        <div className="card-head">
          <h2 id="ov-wfs">{t('ov.workflowsTitle')}</h2>
          <span className="small muted">{workflows.length} {t('ov.workflows')}</span>
        </div>
        <div className="table-wrap">
          <table className="data" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>{t('app.workflow')}</th>
                <th>{model.kind === 'site' ? t('ov.projects') : t('ov.issueTypes')}</th>
                <th className="num" style={{ textAlign: 'right' }}>{t('ov.statuses')}</th>
                <th className="num" style={{ textAlign: 'right' }}>{t('ov.transitions')}</th>
                <th>{t('ov.health')}</th>
                <th>{t('ov.updated')}</th>
                <th><span className="sr-only">{t('app.workflow')}</span></th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => {
                const fs = model.findings.filter((f) => f.wfId === wf.id && f.severity !== 'info');
                // Same score as everywhere else (engine healthScore), counts per severity – hints are not warnings
                const wfScore = healthScore(fs, wf.transitions.length);
                const counts = { high: 0, medium: 0, low: 0 };
                for (const f of fs) counts[f.severity] = (counts[f.severity] || 0) + 1;
                const editable = actions.canChange?.(wf);
                return (
                  <tr key={wf.id}>
                    <td>
                      <span style={{ fontWeight: 500 }}>{wf.name}</span>
                      <span className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {t(`ov.scope.${wf.scope}`)}{wf.version != null ? ` · v${wf.version}` : ''}
                        {model.kind === 'project' && !editable && <span title={t('role.cannotChange')} style={{ display: 'inline-flex' }}><Icon name="lock" size={13} label={t('role.cannotChange')} /></span>}
                      </span>
                    </td>
                    <td className="small">{model.kind === 'site' ? (wf.projects.length ? wf.projects.map((p) => p.key).join(', ') : <span className="muted">{t('site.inactive')}</span>) : wf.issueTypes.map((i) => i.name).join(', ')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{wf.statuses.length}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{wf.transitions.length}</td>
                    <td>
                      <span className="meter">
                        <span className="bar"><span style={{ width: `${wfScore}%`, background: tone(wfScore) }} /></span>
                        <span className="small muted nowrap">{fs.length === 0 ? t('ov.scoreGood') : sevCounts(t, counts)}</span>
                      </span>
                    </td>
                    <td className="nowrap small muted">{t.date(wf.updated, false)}</td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <button type="button" className="btn small ghost" onClick={() => actions.selectWorkflow(wf.id, 'diagram')}><Icon name="diagram" />{t('tab.diagram')}</button>
                      <button type="button" className="btn small ghost" onClick={() => actions.selectWorkflow(wf.id, 'transitions')}><Icon name="list" />{t('tab.transitions')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="ov-apps">
        <h2 id="ov-apps">{t('ov.appsTitle')}</h2>
        {apps.length === 0 && <EmptyState icon="layers" title={t('ov.appsNone')} />}
        {apps.length > 0 && (
          <div className="table-wrap">
            <table className="data" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>{t('ref.app')}</th>
                  <th style={{ width: '32%' }}>{t('ov.rules')}</th>
                  <th className="num" style={{ textAlign: 'right' }}>{t('ov.conditions')}</th>
                  <th className="num" style={{ textAlign: 'right' }}>{t('ov.validators')}</th>
                  <th className="num" style={{ textAlign: 'right' }}>{t('ov.postfunctions')}</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.key} className="clickable" {...rowAction(() => actions.openRef('app', a.key))}>
                    <td>
                      <button type="button" className="link-btn" style={{ textDecoration: 'none', color: 'var(--text)' }} onClick={(e) => { e.stopPropagation(); actions.openRef('app', a.key); }}><VendorBadge vendor={a} /></button>
                      {a.maker && <span className="muted small"> {a.maker}</span>}
                      {a.disabled > 0 && <span className="badge disabled" style={{ marginLeft: 6 }}>{a.disabled} {t('ov.disabled')}</span>}
                    </td>
                    <td>
                      <span className="meter">
                        <span className="bar"><span style={{ width: `${(a.total / maxApp) * 100}%` }} /></span>
                        <span className="small muted num">{a.total}</span>
                      </span>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>{a.condition}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{a.validator}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{a.postfunction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}
