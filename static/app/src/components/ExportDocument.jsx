// Static document rendered with renderToStaticMarkup for the HTML export. Reuses the
// same rule/condition components as the app so the export always matches the UI.
import { LangContext, useT } from '../lib/i18n.jsx';
import { AppContext, ConditionTree, RuleList, StatusPill, VendorBadge, SevBadge, Kpi, ScoreRing, scoreLabelKey } from './common.jsx';
import { buildSections } from './Transitions.jsx';
import { layoutWorkflow, diagramSvg } from '../../../../src/shared/diagram.js';
import { describeWorkflow, describeTransition } from '../../../../src/shared/explain.js';
import { findingText, t as translate } from '../../../../src/shared/i18n.js';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import { allRules } from '../../../../src/shared/engine.js';

export function ExportDocument({ model, workflows, notes, opts, logo }) {
  return (
    <LangContext.Provider value={opts.lang}>
      <AppContext.Provider value={{ model, notes, actions: {}, staticRender: true }}>
        <Doc model={model} workflows={workflows} notes={notes} opts={opts} logo={logo} />
      </AppContext.Provider>
    </LangContext.Provider>
  );
}

function Doc({ model, workflows, notes, opts, logo }) {
  const t = useT();
  const inc = opts.include;
  const only = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const title = opts.label || (workflows.length === 1 ? workflows[0].name : model.project ? `${model.project.key} – ${model.project.name}` : t('app.subtitleSite'));
  const findingKeys = new Set(model.findings.filter((f) => f.tKey && f.severity !== 'info').map((f) => f.tKey));
  const wfIds = new Set(workflows.map((w) => w.id));
  const findings = model.findings.filter((f) => wfIds.has(f.wfId) && (!only || !f.tKey || only.has(f.tKey)));
  const s = model.stats;

  return (
    <>
      <div className="topbar">
        <img className="logo" src={logo} alt="SUPERPORT" />
        <span className="tag">{t('ex.documentation')}</span>
        <span className="subtitle">{[opts.customer, title].filter(Boolean).join(' – ')}</span>
        <span className="spacer" />
        <span className="subtitle">{t('app.generated', { date: t.date(model.generatedAt) })}</span>
      </div>
      <div className="toolbar export-tools" style={{ padding: '6px 16px' }}>
        <button type="button" className="btn small" data-act="expand">▼ {t('tt.expandAll')}</button>
        <button type="button" className="btn small" data-act="collapse">▲ {t('tt.collapseAll')}</button>
        <span className="popover">
          <button type="button" className="btn small" data-act="vendors">◧ {t('tt.vendorFilter')}</button>
          <span className="col-panel" data-panel="vendors" hidden>
            {model.vendors.map((v) => (
              <label key={v.key}><input type="checkbox" data-vendor-filter={v.key} defaultChecked /> <VendorBadge vendor={v} /></label>
            ))}
          </span>
        </span>
        <span className="popover">
          <button type="button" className="btn small" data-act="kinds">▰ {t('tt.elementFilter')}</button>
          <span className="col-panel" data-panel="kinds" hidden>
            {['condition', 'validator', 'postfunction'].map((k) => (
              <label key={k}><input type="checkbox" data-kind-filter={k} defaultChecked /> {t(`kind.${k}`)}</label>
            ))}
          </span>
        </span>
        <span className="grow" />
        <span className="small muted" data-info="" />
        <input type="search" data-search="" placeholder={t('app.search')} style={{ width: 260 }} />
        <button type="button" className="btn small" data-act="prev">▲</button>
        <button type="button" className="btn small" data-act="next">▼</button>
      </div>

      <main className="page">
        <nav className="card accent">
          <div className="section-title">{t('ex.toc')}</div>
          <div className="row">
            <a className="chip" href="#summary">{t('ov.summaryTitle')}</a>
            {workflows.map((wf) => <a key={wf.id} className="chip" href={`#wf-${wf.id}`}>{wf.name}</a>)}
            {inc.impact && <a className="chip" href="#impact">{t('tab.impact')}</a>}
            {inc.health && <a className="chip" href="#health">{t('tab.health')}</a>}
          </div>
        </nav>

        <section id="summary">
          <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 320px) 1fr' }}>
            <div className="card accent" style={{ marginBottom: 0 }}>
              <div className="section-title">{t('ov.health')}</div>
              <div className="score"><ScoreRing score={s.healthScore} /><div style={{ fontSize: 16, fontWeight: 700 }}>{t(scoreLabelKey(s.healthScore))}</div></div>
            </div>
            <div className="grid kpis">
              <Kpi value={workflows.length} label={t('ov.workflows')} />
              <Kpi value={s.statuses} label={t('ov.statuses')} />
              <Kpi value={workflows.reduce((a, w) => a + w.transitions.length, 0)} label={t('ov.transitions')} />
              <Kpi value={s.condition} label={t('ov.conditions')} />
              <Kpi value={s.validator} label={t('ov.validators')} />
              <Kpi value={s.postfunction} label={t('ov.postfunctions')} />
              <Kpi value={s.apps} label={t('ov.apps')} accent />
              <Kpi value={s.thirdPartyRules} label={t('ov.thirdPartyRules')} accent />
            </div>
          </div>
          {model.vendors.some((v) => v.thirdParty) && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>{t('ov.appsTitle')}</h3>
              <table className="data">
                <thead><tr><th>{t('ref.app')}</th><th>{t('ov.conditions')}</th><th>{t('ov.validators')}</th><th>{t('ov.postfunctions')}</th><th>{t('ov.transitions')}</th></tr></thead>
                <tbody>
                  {model.vendors.filter((v) => v.thirdParty).map((v) => (
                    <tr key={v.key}><td><VendorBadge vendor={v} /> <span className="muted small">{v.appKey}</span></td><td>{v.condition}</td><td>{v.validator}</td><td>{v.postfunction}</td><td>{v.transitionCount}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {workflows.map((wf) => {
          const sections = buildSections(wf, t)
            .map((sec) => ({ ...sec, rows: sec.rows.filter((r) => !only || only.has(r.tr.key)) }))
            .filter((sec) => sec.rows.length);
          if (!sections.length) return null;
          return (
            <section key={wf.id} id={`wf-${wf.id}`} style={{ marginTop: 24 }}>
              <h2 style={{ fontSize: 18, borderBottom: '3px solid var(--sp-orange)', paddingBottom: 6 }}>{wf.name}</h2>
              <div className="small muted" style={{ marginBottom: 10 }}>
                {t(`ov.scope.${wf.scope}`)}{wf.version != null ? ` · v${wf.version}` : ''}{wf.updated ? ` · ${t('ov.updated')}: ${t.date(wf.updated)}` : ''}
                {wf.issueTypes.length ? ` · ${t('ov.issueTypes')}: ${wf.issueTypes.map((i) => i.name).join(', ')}` : ''}
                {wf.projects?.length ? ` · ${t('ov.projects')}: ${wf.projects.map((p) => p.key).join(', ')}` : ''}
              </div>
              {inc.explain && <div className="explain">{describeWorkflow(model, wf, t.lang).map((l, i) => <p key={i}>{l}</p>)}</div>}
              {inc.diagram && (
                <div className="card" style={{ overflowX: 'auto' }}>
                  <div dangerouslySetInnerHTML={{ __html: diagramSvg(layoutWorkflow(wf, { mode: 'jira', findingKeys, wrap: 6 }), { anyLabel: t('dg.any') }) }} />
                </div>
              )}
              {inc.transitions && sections.map((sec) => (
                <div className="sec" key={sec.id}>
                  <div className="sh open" data-toggle="">
                    <span className="caret">▶</span>
                    {sec.status ? <StatusPill status={sec.status} /> : null}
                    <span className="stit">{sec.status ? `${t('tt.step')}: ` : ''}{sec.title}</span>
                    <span className="smet">{sec.rows.length === 1 ? t('tt.transition1') : t('tt.transitionsN', { n: sec.rows.length })}</span>
                  </div>
                  <div className="sb tt-wrap">
                    <table className="tt">
                      <colgroup>
                        <col style={{ width: 70 }} /><col style={{ width: 130 }} /><col style={{ width: 150 }} /><col style={{ width: 130 }} /><col style={{ width: 100 }} />
                        <col style={{ width: 250 }} /><col style={{ width: 250 }} /><col style={{ width: 250 }} />
                        {inc.notes && <col style={{ width: 160 }} />}
                      </colgroup>
                      <thead>
                        <tr>
                          {['id', 'source', 'transition', 'target', 'screen', 'conditions', 'validators', 'postfunctions'].map((c) => <th key={c}>{t(`tt.col.${c}`)}</th>)}
                          {inc.notes && <th>{t('tt.col.note')}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {sec.rows.map(({ tr: x }) => {
                          const rules = allRules(x);
                          return (
                            <tr key={x.key} data-vendors={[...new Set(rules.map((r) => r.vendor.key))].join(' ')} data-kinds={[...new Set(rules.map((r) => r.kind))].join(' ')}>
                              <td><span className="tid">{x.id}</span><span className="small muted">{t(`tt.type.${x.type}`)}</span></td>
                              <td>{x.isInitial ? t('dg.start') : x.isGlobal ? t('tt.any') : <StatusPill status={sec.status} />}</td>
                              <td>
                                <strong>{x.name}</strong>
                                {inc.explain && <div className="small muted" style={{ marginTop: 4 }}>{describeTransition(wf, x, t.lang, model.findings).slice(1).join(' ')}</div>}
                              </td>
                              <td>{x.to ? <StatusPill status={x.to} /> : t('tt.loop')}</td>
                              <td>{x.screen ? x.screen.name : '–'}</td>
                              <td><ConditionTree tree={x.conditions} /></td>
                              <td><RuleList rules={x.validators} /></td>
                              <td><RuleList rules={[...x.postFunctions, ...x.triggers]} /></td>
                              {inc.notes && <td style={{ whiteSpace: 'pre-wrap' }}>{notes?.[wf.id]?.[x.id]?.text || ''}</td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </section>
          );
        })}

        {inc.impact && (
          <section id="impact" style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 18, borderBottom: '3px solid var(--sp-orange)', paddingBottom: 6 }}>{t('im.title')}</h2>
            {REF_TYPES.filter((rt) => model.index[rt]).map((rt) => (
              <div className="sec" key={rt}>
                <div className="sh" data-toggle="">
                  <span className="caret">▶</span>
                  <span className="stit">{t(`refs.${rt}`)}</span>
                  <span className="smet">{Object.keys(model.index[rt]).length}</span>
                </div>
                <div className="sb">
                  <table className="data">
                    <thead><tr><th>Name</th><th>ID</th><th>{t('ov.transitions')}</th><th>{t('im.affected')}</th></tr></thead>
                    <tbody>
                      {Object.values(model.index[rt]).sort((a, b) => b.transitionCount - a.transitionCount).map((e) => (
                        <tr key={e.id}>
                          <td><strong>{e.name}</strong>{e.resolved === false && <span className="chip bad"> {t('im.unresolved')}</span>}{e.inactive && <span className="chip warn"> {t('im.inactive')}</span>}</td>
                          <td><code>{e.id}</code></td>
                          <td>{e.transitionCount}</td>
                          <td className="small">{[...new Set(e.usages.map((u) => `${u.wfName} › ${u.tName}`))].join(' · ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        )}

        {inc.health && (
          <section id="health" style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 18, borderBottom: '3px solid var(--sp-orange)', paddingBottom: 6 }}>{t('hc.title')} · {s.healthScore}/100</h2>
            {findings.length === 0 && <div className="empty">{t('ov.findingsNone')}</div>}
            <table className="data">
              <tbody>
                {findings.map((f) => {
                  const ft = findingText(t.lang, f);
                  return (
                    <tr key={f.id}>
                      <td className="nowrap"><SevBadge sev={f.severity} /></td>
                      <td><strong>{ft.title}</strong><div className="small muted">{f.wfName}{f.tName ? ` › ${f.tName}` : ''}</div></td>
                      <td className="small">{ft.fix}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        <div className="footer">{translate(opts.lang, 'ex.createdBy')} · {t.date(new Date().toISOString())}</div>
      </main>
    </>
  );
}
