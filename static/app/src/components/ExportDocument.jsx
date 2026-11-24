/**
 * Static document rendered with renderToStaticMarkup for the HTML export. Reads like a guide: a summary with the
 * verdict and the most important improvements, then per workflow the usual path from start to done (who, what is
 * checked, what happens automatically and why), other routes, the diagram, improvements, every transition in plain
 * words and – collapsed – the technical rule table. Reuses the app's rule components so the export matches the UI.
 *
 * @file        static/app/src/components/ExportDocument.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-24
 */

import { LangContext, useT } from '../lib/i18n.jsx';
import { AppContext, ConditionTree, RuleList, StatusPill, VendorBadge, SevBadge, ScoreRing, scoreLabelKey } from './common.jsx';
import { buildSections } from './Transitions.jsx';
import { layoutWorkflow, diagramSvg } from '../../../../src/shared/diagram.js';
import { findingText, t as translate } from '../../../../src/shared/i18n.js';
import { REF_TYPES } from '../../../../src/shared/rules.js';
import { allRules } from '../../../../src/shared/engine.js';
import { workflowStory, siteStory, exportGlossary, exportScope } from '../../../../src/shared/story.js';

export function ExportDocument({ model, workflows, notes, opts, logo }) {
  return (
    <LangContext.Provider value={opts.lang}>
      <AppContext.Provider value={{ model, notes, actions: {}, staticRender: true }}>
        <Doc model={model} workflows={workflows} notes={notes} opts={opts} logo={logo} />
      </AppContext.Provider>
    </LangContext.Provider>
  );
}

const vendorsOf = (tr) => (tr ? [...new Set(allRules(tr).map((r) => r.vendor.key))].join(' ') : '');
const kindsOf = (tr) => (tr ? [...new Set(allRules(tr).map((r) => r.kind))].join(' ') : '');

/** Collapsible block (the export script toggles .open; print expands everything). */
function Fold({ title, meta, open = false, children, id }) {
  return (
    <div className="sec" id={id}>
      <div className={`sh ${open ? 'open' : ''}`} data-toggle="">
        <span className="caret">▶</span>
        <span className="stit">{title}</span>
        {meta != null && <span className="smet">{meta}</span>}
      </div>
      <div className="sb">{children}</div>
    </div>
  );
}

function Verdict({ v }) {
  return <div className={`verdict ${v.level}`}><span className="dot" />{v.text}</div>;
}

function Improvement({ imp, showWhere = true }) {
  const t = useT();
  return (
    <div className={`imp ${imp.severity}`}>
      <div className="imp-head">
        <span className={`prio ${imp.priority}`}>{imp.priority}</span>
        <strong>{imp.title}</strong>
        {imp.count > 1 && <span className="muted small">× {imp.count}</span>}
        <span className="spacer" />
        <span className="small muted">{t('g.improve.effort')}: {imp.effortText}</span>
      </div>
      <div className="kv">
        <div><span className="k">{t('g.improve.matters')}</span><span>{imp.matters}</span></div>
        <div><span className="k">{t('g.improve.fix')}</span><span>{imp.fix}</span></div>
        {showWhere && imp.where.length > 0 && (
          <div><span className="k">{t('g.improve.where')}</span><span className="row">{imp.where.slice(0, 12).map((w) => <span key={w} className="chip">{w}</span>)}{imp.where.length > 12 ? ' …' : ''}</span></div>
        )}
      </div>
      {imp.autofix && <div className="autofix">✓ {t(imp.autofix === 'some' ? 'g.improve.autofixSome' : 'g.improve.autofix')}</div>}
    </div>
  );
}

/** Who / checks / automatic / why rows of one transition. */
function StepFacts({ x, compact }) {
  const t = useT();
  const none = <span className="muted">{t('g.none')}</span>;
  return (
    <div className="kv">
      <div><span className="k">{t('g.who')}</span><span>{x.who}</span></div>
      {x.screen && <div><span className="k">{t('tt.col.screen')}</span><span>{x.screen}</span></div>}
      {(!compact || x.checks.length > 0) && <div><span className="k">{t('g.checks')}</span><span>{x.checks.length ? <ul>{x.checks.map((c, i) => <li key={i}>{c}</li>)}</ul> : none}</span></div>}
      {(!compact || x.automatic.length > 0) && <div><span className="k">{t('g.auto')}</span><span>{x.automatic.length ? <ul>{x.automatic.map((c, i) => <li key={i}>{c}</li>)}</ul> : none}</span></div>}
      {x.why.length > 0 && <div><span className="k">{t('g.why')}</span><span>{x.why.length === 1 ? x.why[0] : <ul>{x.why.map((w, i) => <li key={i}>{w}</li>)}</ul>}</span></div>}
    </div>
  );
}

function Findings({ list }) {
  const t = useT();
  if (!list.length) return null;
  return (
    <div className="tfind">
      <div className="k">{t('g.cards.issues')}</div>
      {list.map((f, i) => (
        <div key={i} className="tf">
          <SevBadge sev={f.severity} /> <strong>{f.title}</strong>
          <div className="small">{f.matters}</div>
          <div className="small"><span className="muted">{t('g.improve.fix')}:</span> {f.fix}{f.autofix ? ' (Autopilot)' : ''}</div>
        </div>
      ))}
    </div>
  );
}

function Journey({ wf, story }) {
  const t = useT();
  if (!story.journey.length) return <div className="note-box amber">{t('g.journey.none')}</div>;
  const status = (ref) => wf.statuses.find((s) => s.ref === ref);
  return (
    <ol className="journey">
      <li className="jnode start"><span className="bullet">●</span><span>{t('g.journey.start')}</span></li>
      {story.journey.flatMap((x) => {
        const tr = wf.transitions.find((y) => y.key === x.key);
        return [
          <li key={`s${x.key}`} className="jstep" data-item="" data-vendors={vendorsOf(tr)} data-kinds={kindsOf(tr)}>
            <div className="jcard">
              <div className="jtitle"><span className="num">{t('g.step', { n: x.n })}</span><strong>{x.name}</strong></div>
              <StepFacts x={x} compact />
              <Findings list={x.findings} />
            </div>
          </li>,
          <li key={`n${x.key}`} className="jnode"><span className="bullet">↓</span><StatusPill status={status(tr.to?.ref) || tr.to} /></li>,
        ];
      })}
      <li className="jnode end"><span className="bullet">✓</span><span>{story.journeyEnd}</span></li>
    </ol>
  );
}

function TransitionCard({ wf, x, note }) {
  const t = useT();
  const tr = wf.transitions.find((y) => y.key === x.key);
  const status = (ref) => wf.statuses.find((s) => s.ref === ref);
  return (
    <div className="tcard" id={`t-${wf.id}-${x.key}`} data-item="" data-vendors={vendorsOf(tr)} data-kinds={kindsOf(tr)}>
      <div className="tc-head">
        <strong>{x.name}</strong>
        <span className="small muted">ID {x.id}</span>
        <span className="spacer" />
        {x.onPath && <span className="chip green">{t('g.col.path')}</span>}
        {x.findings.length > 0 && <span className="chip bad">{x.findings.length}</span>}
      </div>
      <div className="tc-route">
        {tr.isInitial ? <span className="muted">{t('dg.start')}</span> : tr.isGlobal ? <span className="muted">{t('tt.any')}</span> : tr.from.map((f) => <StatusPill key={f.ref} status={status(f.ref) || f} />)}
        <span className="arrow">→</span>
        {tr.to ? <StatusPill status={status(tr.to.ref) || tr.to} /> : <span className="muted">{t('tt.loop')}</span>}
      </div>
      <StepFacts x={x} />
      {x.apps.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>{t('refs.app')}: {x.apps.join(', ')}</div>}
      <Findings list={x.findings} />
      {note && <div className="tnote"><span className="k">{t('tt.col.note')}</span> {note}</div>}
    </div>
  );
}

function TechTable({ wf, only, inc, notes }) {
  const t = useT();
  const sections = buildSections(wf, t)
    .map((sec) => ({ ...sec, rows: sec.rows.filter((r) => !only || only.has(r.tr.key)) }))
    .filter((sec) => sec.rows.length);
  return sections.map((sec) => (
    <div className="tsec" key={sec.id}>
      <div className="tsec-h">
        {sec.status ? <StatusPill status={sec.status} /> : null}
        <span className="stit">{sec.status ? `${t('tt.step')}: ` : ''}{sec.title}</span>
        <span className="smet">{sec.rows.length === 1 ? t('tt.transition1') : t('tt.transitionsN', { n: sec.rows.length })}</span>
      </div>
      <div className="tt-wrap">
        <table className="tt">
          <colgroup>
            <col style={{ width: 70 }} /><col style={{ width: 120 }} /><col style={{ width: 140 }} /><col style={{ width: 120 }} /><col style={{ width: 100 }} />
            <col style={{ width: 240 }} /><col style={{ width: 240 }} /><col style={{ width: 240 }} />
            {inc.notes && <col style={{ width: 150 }} />}
          </colgroup>
          <thead>
            <tr>
              {['id', 'source', 'transition', 'target', 'screen', 'conditions', 'validators', 'postfunctions'].map((c) => <th key={c}>{t(`tt.col.${c}`)}</th>)}
              {inc.notes && <th>{t('tt.col.note')}</th>}
            </tr>
          </thead>
          <tbody>
            {sec.rows.map(({ tr: x }) => (
              <tr key={x.key} data-item="" data-vendors={vendorsOf(x)} data-kinds={kindsOf(x)}>
                <td><span className="tid">{x.id}</span><span className="small muted">{t(`tt.type.${x.type}`)}</span></td>
                <td>{x.isInitial ? t('dg.start') : x.isGlobal ? t('tt.any') : <StatusPill status={sec.status} />}</td>
                <td><strong>{x.name}</strong></td>
                <td>{x.to ? <StatusPill status={x.to} /> : t('tt.loop')}</td>
                <td>{x.screen ? x.screen.name : '–'}</td>
                <td><ConditionTree tree={x.conditions} /></td>
                <td><RuleList rules={x.validators} /></td>
                <td><RuleList rules={[...x.postFunctions, ...x.triggers]} /></td>
                {inc.notes && <td style={{ whiteSpace: 'pre-wrap' }}>{notes?.[wf.id]?.[x.id]?.text || ''}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ));
}

function WorkflowSection({ model, wf, opts, notes, findingKeys, only }) {
  const t = useT();
  const inc = opts.include;
  const story = workflowStory(model, wf, t.lang);
  const cards = story.transitions.filter((x) => !only || only.has(x.key));
  if (!cards.length) return null;
  // story comes from the export scope: for a selection it already holds only the selected transitions' findings
  const imps = story.improvements;
  return (
    <section className="wf" id={`wf-${wf.id}`}>
      <div className="wf-head">
        <h2 className="ex-h2">{wf.name}</h2>
        <div className="small muted">
          {t(`ov.scope.${wf.scope}`)}{wf.version != null ? ` · v${wf.version}` : ''}{wf.updated ? ` · ${t('ov.updated')}: ${t.date(wf.updated)}` : ''}
          {wf.issueTypes.length ? ` · ${t('ov.issueTypes')}: ${wf.issueTypes.map((i) => i.name).join(', ')}` : ''}
          {wf.projects?.length ? ` · ${t('ov.projects')}: ${wf.projects.map((p) => p.key).join(', ')}` : ''}
        </div>
      </div>

      {inc.explain && (
        <div className="card inshort">
          <div className="section-title">{t('g.inShort')}</div>
          <Verdict v={story.verdict} />
          <ul className="bullets">{story.summary.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      )}

      {inc.explain && !only && (
        <div className="card">
          <div className="section-title">{t('g.journey.title')}</div>
          <p className="muted small">{t('g.journey.intro')}</p>
          <Journey wf={wf} story={story} />
        </div>
      )}

      {inc.explain && !only && (
        <div className="card">
          <div className="section-title">{t('g.other.title')}</div>
          {story.others.length === 0 ? <p className="muted">{t('g.other.none')}</p> : (
            <>
              <p className="muted small">{t('g.other.intro')}</p>
              <div className="table-wrap">
                <table className="data others">
                  <tbody>
                    {story.others.map((o) => (
                      <tr key={o.key}>
                        <td className="nowrap"><span className={`chip ${o.kind === 'global' ? 'amber' : o.kind === 'back' ? 'blue' : o.kind === 'done' ? 'green' : ''}`}>{o.kindText}</span></td>
                        <td><a href={`#t-${wf.id}-${o.key}`}><strong>{o.name}</strong></a><div className="small muted">{o.from ? `${o.from} → ` : ''}{o.to || t('tt.loop')}</div></td>
                        <td className="small">{o.who}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {inc.diagram && (
        <div className="card diagram">
          <div className="section-title">{t('tab.diagram')}</div>
          <div className="diagram-box" dangerouslySetInnerHTML={{ __html: diagramSvg(layoutWorkflow(wf, { mode: 'jira', findingKeys, wrap: 6 }), { anyLabel: t('dg.any') }) }} />
        </div>
      )}

      {inc.health && (
        <div className="card">
          <div className="section-title">{t('g.improve.title')}</div>
          {imps.length === 0 ? <p className="ok-line">✓ {t('g.improve.none')}</p> : (
            <>
              <p className="muted small">{t('g.improve.intro')}</p>
              {imps.map((imp) => <Improvement key={imp.code} imp={imp} />)}
            </>
          )}
        </div>
      )}

      {inc.explain && (
        <Fold title={t('g.cards.title')} meta={cards.length === 1 ? t('tt.transition1') : t('tt.transitionsN', { n: cards.length })} open>
          <p className="muted small fold-intro">{t('g.cards.intro')}</p>
          <div className="tcards">
            {cards.map((x) => <TransitionCard key={x.key} wf={wf} x={x} note={inc.notes ? notes?.[wf.id]?.[x.id]?.text : ''} />)}
          </div>
        </Fold>
      )}

      {inc.transitions && (
        <Fold title={t('g.tech.title')} meta={t('g.tech.intro')} open={!inc.explain}>
          <TechTable wf={wf} only={only} inc={inc} notes={notes} />
        </Fold>
      )}
    </section>
  );
}

function Doc({ model, workflows, notes, opts, logo }) {
  const t = useT();
  const inc = opts.include;
  const only = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const title = opts.label || (workflows.length === 1 ? workflows[0].name : model.project ? `${model.project.key} – ${model.project.name}` : t('app.subtitleSite'));
  const findingKeys = new Set(model.findings.filter((f) => f.tKey && f.severity !== 'info').map((f) => f.tKey));
  // Score, KPIs and apps of what is exported, not of the whole site
  const scope = exportScope(model, workflows, opts.onlyKeys);
  const sub = { ...model, findings: scope.findings };
  const findings = scope.findings;
  const site = siteStory(sub, t.lang);
  const s = scope.stats;
  const apps = scope.vendors.filter((v) => v.thirdParty);
  const shown = (w) => w.transitions.filter((x) => !only || only.has(x.key));

  return (
    <>
      <div className="topbar">
        <img className="logo" src={logo} alt="SUPERPORT" />
        <span className="tag">{t('ex.documentation')}</span>
        <span className="subtitle">{[opts.customer, title].filter(Boolean).join(' – ')}</span>
        <span className="spacer" />
        <span className="subtitle">{t('app.generated', { date: t.date(model.generatedAt) })}</span>
      </div>
      <div className="toolbar export-tools">
        <button type="button" className="btn small" data-act="expand">▼ {t('tt.expandAll')}</button>
        <button type="button" className="btn small" data-act="collapse">▲ {t('tt.collapseAll')}</button>
        <span className="popover">
          <button type="button" className="btn small" data-act="vendors">◧ {t('tt.vendorFilter')}</button>
          <span className="col-panel" data-panel="vendors" hidden>
            {scope.vendors.map((v) => (
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
        <button type="button" className="btn small" data-act="print">⎙ {t('g.print')}</button>
        <span className="grow" />
        <span className="small muted" data-info="" />
        <input type="search" data-search="" placeholder={t('app.search')} />
        <button type="button" className="btn small" data-act="prev" aria-label="▲">▲</button>
        <button type="button" className="btn small" data-act="next" aria-label="▼">▼</button>
      </div>

      <main className="page ex">
        <header className="ex-cover">
          <div className="eyebrow">{t('ex.documentation')}{opts.customer ? ` · ${opts.customer}` : ''}</div>
          <h1>{title}</h1>
          <div className="muted">{t('app.generated', { date: t.date(model.generatedAt) })}</div>
        </header>

        <nav className="card toc">
          <div className="section-title">{t('ex.toc')}</div>
          <ol>
            <li><a href="#summary">{t('g.exec.title')}</a></li>
            {workflows.filter((wf) => shown(wf).length).map((wf) => <li key={wf.id}><a href={`#wf-${wf.id}`}>{wf.name}</a></li>)}
            {inc.impact && <li><a href="#impact">{t('tab.impact')}</a></li>}
            {inc.health && <li><a href="#health">{t('tab.health')}</a></li>}
            {inc.explain && <li><a href="#glossary">{t('g.glossary.title')}</a></li>}
          </ol>
        </nav>

        <section id="summary">
          <h2 className="ex-h2">{t('g.exec.title')}</h2>
          <div className="exec">
            <div className="card exec-score">
              <div className="score"><ScoreRing score={s.healthScore} /><div><div className="small muted">{t('ov.health')}</div><div className="score-label">{t(scoreLabelKey(s.healthScore))}</div></div></div>
              <Verdict v={site.verdict} />
              <div className="kpis-mini">
                <div><b>{scope.workflows.length}</b><span>{t('ov.workflows')}</span></div>
                <div><b>{s.statuses}</b><span>{t('ov.statuses')}</span></div>
                <div><b>{s.transitions}</b><span>{t('ov.transitions')}</span></div>
                <div><b>{s.rules}</b><span>{t('ov.rules')}</span></div>
                <div><b>{apps.length}</b><span>{t('ov.apps')}</span></div>
              </div>
            </div>
            <div className="card">
              <div className="section-title">{t('g.exec.top')}</div>
              {site.top.length === 0 ? <p className="ok-line">✓ {t('g.exec.noTop')}</p> : site.top.map((imp) => <Improvement key={imp.code} imp={imp} />)}
            </div>
          </div>
          {inc.explain && <div className="note-box howto"><strong>{t('g.read.title')}.</strong> {t('g.read.text')}</div>}
          {apps.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="section-title">{t('ov.appsTitle')}</div>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{t('ref.app')}</th><th>{t('ov.conditions')}</th><th>{t('ov.validators')}</th><th>{t('ov.postfunctions')}</th><th>{t('ov.transitions')}</th></tr></thead>
                  <tbody>
                    {apps.map((v) => (
                      <tr key={v.key}><td><VendorBadge vendor={v} /> <span className="muted small">{v.appKey}</span></td><td>{v.condition}</td><td>{v.validator}</td><td>{v.postfunction}</td><td>{v.transitionCount}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {workflows.map((wf) => <WorkflowSection key={wf.id} model={sub} wf={wf} opts={opts} notes={notes} findingKeys={findingKeys} only={only} />)}

        {inc.impact && (
          <section id="impact">
            <h2 className="ex-h2">{t('im.title')}</h2>
            {REF_TYPES.filter((rt) => scope.index[rt]).map((rt) => (
              <Fold key={rt} title={t(`refs.${rt}`)} meta={Object.keys(scope.index[rt]).length}>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Name</th><th>ID</th><th>{t('ov.transitions')}</th><th>{t('im.affected')}</th></tr></thead>
                    <tbody>
                      {Object.values(scope.index[rt]).sort((a, b) => b.transitionCount - a.transitionCount).map((e) => (
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
              </Fold>
            ))}
          </section>
        )}

        {inc.health && (
          <section id="health">
            <h2 className="ex-h2">{t('hc.title')} · {s.healthScore}/100</h2>
            {findings.length === 0 && <p className="ok-line">✓ {t('ov.findingsNone')}</p>}
            {findings.length > 0 && (
              <div className="card">
                <div className="table-wrap">
                  <table className="data health">
                    <thead><tr><th>{t('g.col.sev')}</th><th>{t('g.col.problem')}</th><th>{t('g.improve.matters')}</th><th>{t('g.improve.fix')}</th></tr></thead>
                    <tbody>
                      {findings.map((f) => {
                        const ft = findingText(t.lang, f);
                        return (
                          <tr key={f.id}>
                            <td className="nowrap"><SevBadge sev={f.severity} /></td>
                            <td><strong>{ft.title}</strong><div className="small muted">{f.wfName}{f.tName ? ` › ${f.tName}` : ''}</div></td>
                            <td className="small">{t(`why.finding.${f.code}`)}</td>
                            <td className="small">{ft.fix}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

        {inc.explain && (
          <section id="glossary">
            <h2 className="ex-h2">{t('g.glossary.title')}</h2>
            <dl className="gloss card">
              {exportGlossary(t.lang).flatMap((g) => [<dt key={`t${g.key}`}>{g.term}</dt>, <dd key={`d${g.key}`}>{g.text}</dd>])}
            </dl>
          </section>
        )}

        <div className="footer">{translate(opts.lang, 'ex.createdBy')} · {t.date(new Date().toISOString())}</div>
      </main>
    </>
  );
}
