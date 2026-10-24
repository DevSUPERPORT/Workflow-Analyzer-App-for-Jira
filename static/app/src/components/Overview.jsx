import { useT } from '../lib/i18n.jsx';
import { useApp, Kpi, ScoreRing, scoreLabelKey, SevBadge, VendorBadge, EmptyState } from './common.jsx';
import Icon from './Icon.jsx';
import { describeWorkflow } from '../../../../src/shared/explain.js';
import { findingText } from '../../../../src/shared/i18n.js';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import { governance, actionPlan } from '../../../../src/shared/insights.js';

const tone = (score) => (score >= 80 ? 'var(--ok)' : score >= 55 ? 'var(--accent)' : 'var(--high)');

export default function Overview({ model, workflows }) {
  const t = useT();
  const { actions, caps } = useApp();
  const s = model.stats;
  const apps = model.vendors.filter((v) => v.thirdParty);
  const maxApp = Math.max(1, ...apps.map((a) => a.total));
  const topFindings = model.findings.filter((f) => f.severity !== 'info').slice(0, 6);
  const plan = actionPlan(model);
  const rules = s.condition + s.validator + s.postfunction;
  const gov = governance(model);

  return (
    <div>
      <section className="grid kpis" aria-label={t('ov.health')}>
        <button type="button" className="tile ink" onClick={() => actions.goHealth('all')} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <ScoreRing score={s.healthScore} size={72} inverted />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span className="l">{t('ov.health')}</span>
            <span style={{ fontSize: 18, fontWeight: 500 }}>{t(scoreLabelKey(s.healthScore))}</span>
            <span className="s">{s.findings.high} {t('ov.severity.high')} · {s.findings.medium} {t('ov.severity.medium')}</span>
          </span>
        </button>
        <Kpi value={s.workflows} label={t('ov.workflows')} sub={`${s.statuses} ${t('ov.statuses')} · ${s.transitions} ${t('ov.transitions')}`} onClick={() => actions.setTab('transitions')} />
        <Kpi value={rules} label={t('ov.rules')} sub={`${s.condition} ${t('ov.conditions')} · ${s.validator} ${t('ov.validators')} · ${s.postfunction} ${t('ov.postfunctions')}`} onClick={() => actions.setTab('transitions')} />
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
          <h2 id="ov-gov">{t('gov.title')}</h2>
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
                const hi = fs.filter((f) => f.severity === 'high').length;
                const wfScore = Math.max(0, 100 - hi * 15 - (fs.length - hi) * 4);
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
                        <span className="small muted nowrap">{fs.length === 0 ? t('ov.scoreGood') : `${hi ? `${hi} ${t('ov.severity.high')} · ` : ''}${fs.length - hi} ${t('ov.severity.medium')}`}</span>
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

      <div className="split" style={{ marginBottom: 20 }}>
        <section className="card main" style={{ marginBottom: 0 }} aria-labelledby="ov-apps">
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
                    <tr key={a.key} className="clickable" onClick={() => actions.openRef('app', a.key)}>
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

        <section className="card side" style={{ marginBottom: 0 }} aria-labelledby="ov-find">
          <div className="card-head">
            <h2 id="ov-find">{t('ov.findingsTitle')}</h2>
            {model.findings.length > topFindings.length && <button type="button" className="link-btn small" onClick={() => actions.setTab('health')}>{t('ov.showAll')} ({model.findings.length})</button>}
          </div>
          {topFindings.length === 0 && <EmptyState icon="check" title={t('ov.findingsNone')} />}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {topFindings.map((f) => {
              const ft = findingText(t.lang, f);
              return (
                <li key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                  <SevBadge sev={f.severity} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{ft.title}</div>
                    <div className="small muted">{f.wfName}{f.tName ? ` › ${f.tName}` : ''}</div>
                  </div>
                  {f.tKey && <button type="button" className="btn small ghost" aria-label={`${t('hc.goTo')}: ${ft.title}`} onClick={() => actions.openTransition(f.tKey)}><Icon name="arrowRight" /></button>}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section className="card" aria-labelledby="ov-refs">
        <h2 id="ov-refs">{t('ov.refsTitle')}</h2>
        <div className="row" style={{ gap: 10 }}>
          {REF_TYPES.filter((rt) => s.refs[rt]).map((rt) => {
            const bad = Object.values(model.index[rt] || {}).filter((e) => e.resolved === false || e.inactive).length;
            return (
              <button key={rt} type="button" className="btn" onClick={() => actions.openRefType(rt)}>
                <strong className="num">{s.refs[rt]}</strong> {t(`refs.${rt}`)}
                {bad > 0 && <span className="chip bad" title={t('im.unresolved')}>{bad}</span>}
              </button>
            );
          })}
        </div>
      </section>

      {workflows.length <= 6 && (
        <section className="card" aria-labelledby="ov-sum">
          <h2 id="ov-sum" className="ai-badge" style={{ fontSize: 17 }}><Icon name="sparkle" size={18} />{t('ov.summaryTitle')}</h2>
          <div className="stack">
            {workflows.map((wf) => (
              <div key={wf.id} className="note-box">
                <p style={{ margin: '0 0 4px', fontWeight: 500 }}>{wf.name}</p>
                <p style={{ margin: 0, maxWidth: '75ch' }}>{describeWorkflow(model, wf, t.lang).join(' ')}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
