import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp, StatusPill } from './common.jsx';
import { collectPrincipals, simulatePersona, findPaths, accessMatrix, personaFromSelection } from '../../../../src/shared/insights.js';
import { describeConditionTree } from '../../../../src/shared/explain.js';
import { downloadText } from '../lib/download.js';
import { toCsv } from '../lib/exportCsv.js';
import Icon from './Icon.jsx';

export function principalLabel(p, t) {
  if (p.type === 'reporter') return t('x.reporter');
  if (p.type === 'assignee') return t('x.assignee');
  return `${t(`ref.${p.type}`)}: ${p.name || p.id}`;
}

const STATE_STYLE = {
  yes: { background: 'var(--cat-done)', color: 'var(--cat-done-ink)' },
  no: { background: 'var(--high-bg)', color: 'var(--high)' },
  maybe: { background: 'var(--medium-bg)', color: 'var(--medium)' },
};
export function StateChip({ state }) {
  const t = useT();
  return <span className="sev" style={STATE_STYLE[state]}>{t(`acc.${state}`)}</span>;
}

export default function Access({ model, workflows, persona, setPersona }) {
  const t = useT();
  const { actions } = useApp();
  const [wfId, setWfId] = useState(workflows[0]?.id);
  const wf = workflows.find((w) => w.id === wfId) || workflows[0];
  const principals = useMemo(() => collectPrincipals(workflows), [workflows]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [onlyPersona, setOnlyPersona] = useState(true);
  const [view, setView] = useState('sim');

  const sel = persona.selected;
  const togglePrincipal = (key) => {
    const n = new Set(sel);
    if (n.has(key)) n.delete(key); else n.add(key);
    setPersona({ ...persona, selected: n });
  };
  const personaObj = useMemo(() => personaFromSelection(principals, sel), [sel, principals]);
  const sim = useMemo(() => (wf ? simulatePersona(wf, personaObj) : {}), [wf, personaObj]);
  const blocked = useMemo(() => new Set(onlyPersona && sel.size ? Object.entries(sim).filter(([, v]) => v.state === 'no').map(([k]) => k) : []), [sim, onlyPersona]);
  const paths = useMemo(() => (wf && from && to && from !== to ? findPaths(wf, from, to, { blocked, limit: 3 }) : null), [wf, from, to, blocked]);
  const matrix = useMemo(() => (view === 'matrix' ? accessMatrix(workflows) : null), [workflows, view]);

  if (!wf) return <div className="empty">{t('app.noWorkflows')}</div>;
  const counts = { yes: 0, no: 0, maybe: 0 };
  Object.values(sim).forEach((s) => counts[s.state]++);

  const exportMatrix = () => {
    const rows = [[t('app.workflow'), t('tt.col.transition'), t('im.col.path'), t('acc.everyone'), ...matrix.principals.map((p) => principalLabel(p, t))]];
    for (const r of matrix.rows) rows.push([r.wf.name, r.t.name, `${r.t.from.map((f) => f.name).join(', ') || '*'} -> ${r.t.to?.name || '-'}`, t(`acc.${r.everyone}`), ...r.cells.map((c) => t(`acc.${c}`))]);
    downloadText(toCsv(rows), `${model.project?.key || 'site'}_access_matrix.csv`, 'text/csv;charset=utf-8');
  };

  return (
    <div>
      <div className="card accent">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t('acc.title')}</h2>
          <div className="row">
            {['sim', 'path', 'matrix'].map((v) => <button key={v} type="button" className={`btn small ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{t(`acc.view.${v}`)}</button>)}
          </div>
        </div>
        <p className="muted" style={{ margin: '6px 0 0' }}>{t('acc.intro')}</p>
      </div>

      {view !== 'matrix' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start' }}>
          <div className="card" style={{ position: 'sticky', top: 110 }}>
            <div className="section-title">{t('acc.persona')}</div>
            <p className="small muted" style={{ marginTop: 0 }}>{t('acc.personaHint')}</p>
            {principals.length === 0 && <div className="empty">{t('acc.noPrincipals')}</div>}
            {principals.map((p) => (
              <label key={`${p.type}:${p.id}`} className="row" style={{ flexWrap: 'nowrap', padding: '3px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={sel.has(`${p.type}:${p.id}`)} onChange={() => togglePrincipal(`${p.type}:${p.id}`)} />
                <span className={p.resolved === false ? 'chip bad' : ''}>{principalLabel(p, t)}</span>
              </label>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn small" onClick={() => setPersona({ ...persona, selected: new Set() })}>{t('tt.none')}</button>
              <button type="button" className="btn small dark" onClick={() => actions.showOverlay('persona')}><Icon name="diagram" />{t('acc.showInDiagram')}</button>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 6 }}>
              <StateChip state="yes" /> {counts.yes} <StateChip state="no" /> {counts.no} <StateChip state="maybe" /> {counts.maybe}
            </div>
          </div>

          <div>
            {workflows.length > 1 && (
              <div className="row" style={{ marginBottom: 10 }}>
                <label className="small muted" htmlFor="acc-wf">{t('app.workflow')}</label>
                <select id="acc-wf" value={wf.id} onChange={(e) => setWfId(e.target.value)}>{workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              </div>
            )}

            {view === 'path' && (
              <div className="card">
                <h3>{t('acc.pathTitle')}</h3>
                <div className="row">
                  <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('acc.from')}>
                    <option value="">{t('acc.from')} …</option>
                    {wf.statuses.map((s) => <option key={s.ref} value={s.ref}>{s.name}</option>)}
                  </select>
                  <span>→</span>
                  <select value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('acc.to')}>
                    <option value="">{t('acc.to')} …</option>
                    {wf.statuses.map((s) => <option key={s.ref} value={s.ref}>{s.name}</option>)}
                  </select>
                  <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={onlyPersona} onChange={(e) => setOnlyPersona(e.target.checked)} /> {t('acc.onlyPersona')}</label>
                </div>
                {paths && paths.length === 0 && <div className="alert" style={{ marginTop: 10 }}>{t('acc.noPath')}</div>}
                {paths?.map((p, i) => (
                  <div key={i} className="explain" style={{ marginTop: 10 }}>
                    <p><strong>{t('acc.pathN', { n: i + 1, steps: p.length })}</strong></p>
                    <ol style={{ margin: 0, paddingLeft: 18 }}>
                      {p.map((s, j) => (
                        <li key={j} style={{ marginBottom: 4 }}>
                          <button type="button" className="tname" onClick={() => actions.openTransition(s.t.key)}>{s.t.name}</button> → <StatusPill status={s.t.to} />{' '}
                          <StateChip state={sim[s.t.key]?.state || 'maybe'} />
                          <div className="small muted">{describeConditionTree(s.t.conditions, t.lang) || t('x.tNoConditions')}</div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}

            {view === 'sim' && wf.statuses.map((st) => {
              const outs = wf.transitions.filter((x) => x.from.some((f) => f.ref === st.ref) || (x.isGlobal && x.to?.ref !== st.ref));
              if (!outs.length) return null;
              return (
                <div key={st.ref} className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
                  <div className="row" style={{ marginBottom: 6 }}><StatusPill status={st} /></div>
                  <table className="data">
                    <tbody>
                      {outs.map((x) => {
                        const s = sim[x.key];
                        const why = [...new Set((s?.reasons || []).filter((r) => r.v !== true).map((r) => r.why).filter(Boolean))];
                        return (
                          <tr key={x.key} className="clickable" onClick={() => actions.openTransition(x.key)}>
                            <td style={{ width: 120 }}><StateChip state={s?.state || 'maybe'} /></td>
                            <td style={{ width: '30%' }}><strong>{x.name}</strong> <span className="muted">→ {x.to?.name}</span>{x.isGlobal && <span className="chip" style={{ marginLeft: 6 }}>{t('tt.type.GLOBAL')}</span>}</td>
                            <td className="small">{describeConditionTree(x.conditions, t.lang) || <span className="muted">{t('x.tNoConditions')}</span>}{why.length > 0 && <div className="muted">{why.map((w) => t(w)).join(' · ')}</div>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'matrix' && matrix && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{t('acc.matrixTitle')}</h3>
            <button type="button" className="btn small" onClick={exportMatrix}><Icon name="download" />CSV</button>
          </div>
          <div className="tt-wrap">
            <table className="data" style={{ minWidth: 600 }}>
              <thead>
                <tr>
                  <th>{t('tt.col.transition')}</th>
                  <th>{t('acc.everyone')}</th>
                  {matrix.principals.map((p) => <th key={`${p.type}:${p.id}`} style={{ whiteSpace: 'normal', minWidth: 90 }}>{principalLabel(p, t)}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((r) => (
                  <tr key={r.t.key} className="clickable" onClick={() => actions.openTransition(r.t.key)}>
                    <td><strong>{r.t.name}</strong><div className="small muted">{workflows.length > 1 ? `${r.wf.name} · ` : ''}{r.t.from.map((f) => f.name).join(', ') || t('tt.any')} → {r.t.to?.name || t('tt.loop')}</div></td>
                    <td style={{ textAlign: 'center' }}><Mark s={r.everyone} /></td>
                    {r.cells.map((c, i) => <td key={i} style={{ textAlign: 'center' }}><Mark s={c} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{t('acc.matrixLegend')}</p>
        </div>
      )}
    </div>
  );
}

function Mark({ s }) {
  const t = useT();
  const icon = { yes: 'check', no: 'x', maybe: 'help' }[s];
  const col = { yes: 'var(--ok)', no: 'var(--high)', maybe: 'var(--medium)' }[s];
  return <Icon name={icon} size={16} strokeWidth={2.25} label={t(`acc.${s}`)} style={{ color: col }} />;
}
