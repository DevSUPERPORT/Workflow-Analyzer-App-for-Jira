/**
 * Compare tab: side-by-side comparison of two workflows (statuses, transitions, rules) with a similarity score,
 * and detection of near-duplicate workflow pairs as consolidation candidates.
 *
 * @file        static/app/src/components/Compare.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { useMemo, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { StatusPill } from './common.jsx';
import { similarPairs, compareWorkflows } from '../../../../src/shared/insights.js';
import { describeRule } from '../../../../src/shared/explain.js';
import Icon from './Icon.jsx';

const route = (t, tt) => `${t.from.map((f) => f.name).join(', ') || (t.isInitial ? tt('dg.start') : tt('tt.any'))} → ${t.to?.name || tt('tt.loop')}`;

export default function Compare({ model }) {
  const t = useT();
  const wfs = model.workflows;
  const [a, setA] = useState(wfs[0]?.id || '');
  const [b, setB] = useState(wfs[1]?.id || '');
  const pairs = useMemo(() => similarPairs(wfs, 60, 30), [wfs]);
  const A = wfs.find((w) => w.id === a);
  const B = wfs.find((w) => w.id === b);
  const cmp = useMemo(() => (A && B && A !== B ? compareWorkflows(A, B) : null), [A, B]);

  if (wfs.length < 2) return <div className="card empty">{t('cmp.needTwo')}</div>;

  return (
    <div>
      <div className="card accent">
        <h2 style={{ marginTop: 0 }}>{t('cmp.title')}</h2>
        <p className="muted">{t('cmp.intro')}</p>
        <div className="row">
          <select value={a} onChange={(e) => setA(e.target.value)} aria-label="A">{wfs.map((w) => <option key={w.id} value={w.id}>A · {w.name}</option>)}</select>
          <button type="button" className="btn small" onClick={() => { setA(b); setB(a); }} title={t('cmp.swap')} aria-label={t('cmp.swap')}><Icon name="compare" /></button>
          <select value={b} onChange={(e) => setB(e.target.value)} aria-label="B">{wfs.map((w) => <option key={w.id} value={w.id}>B · {w.name}</option>)}</select>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr', alignItems: 'start' }}>
        <div className="card">
          <h3>{t('cmp.similarTitle')}</h3>
          <p className="small muted" style={{ marginTop: 0 }}>{t('cmp.similarHint')}</p>
          {pairs.length === 0 && <div className="empty">{t('cmp.noSimilar')}</div>}
          {pairs.map((p, i) => (
            <button key={i} type="button" className="impact-item" onClick={() => { setA(p.a.id); setB(p.b.id); }}>
              <span className="name" style={{ whiteSpace: 'normal' }}>{p.a.name}<br /><span className="muted small">↔ {p.b.name}</span></span>
              <span className="n" style={{ color: p.score >= 90 ? 'var(--link)' : undefined }}>{p.score}%</span>
            </button>
          ))}
        </div>

        <div>
          {!cmp && <div className="card empty">{t('cmp.pick')}</div>}
          {cmp && (
            <>
              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>{t('cmp.similarity')}: {cmp.score}%</h3>
                  <span className="small muted">{t('cmp.summary', { same: cmp.transitionsSame, changed: cmp.transitionsChanged.length, a: cmp.transitionsOnlyA.length, b: cmp.transitionsOnlyB.length })}</span>
                </div>
                <div className="bar" style={{ marginTop: 8, height: 10 }}><span style={{ width: `${cmp.score}%` }} /></div>
                {cmp.score >= 90 && <div className="alert" style={{ marginTop: 10 }}>{t('cmp.consolidate')}</div>}
              </div>
              <div className="grid two">
                <div className="card">
                  <h3>{t('cmp.onlyIn', { x: 'A' })}</h3>
                  {cmp.statusesOnlyA.map((s) => <div key={s.ref}><StatusPill status={s} /></div>)}
                  {cmp.transitionsOnlyA.map((x) => <div key={x.key} className="small" style={{ marginTop: 4 }}><strong>{x.name}</strong> <span className="muted">{route(x, t)}</span></div>)}
                  {!cmp.statusesOnlyA.length && !cmp.transitionsOnlyA.length && <div className="empty">–</div>}
                </div>
                <div className="card">
                  <h3>{t('cmp.onlyIn', { x: 'B' })}</h3>
                  {cmp.statusesOnlyB.map((s) => <div key={s.ref}><StatusPill status={s} /></div>)}
                  {cmp.transitionsOnlyB.map((x) => <div key={x.key} className="small" style={{ marginTop: 4 }}><strong>{x.name}</strong> <span className="muted">{route(x, t)}</span></div>)}
                  {!cmp.statusesOnlyB.length && !cmp.transitionsOnlyB.length && <div className="empty">–</div>}
                </div>
              </div>
              {cmp.transitionsChanged.length > 0 && (
                <div className="card">
                  <h3>{t('cmp.changed')}</h3>
                  <table className="data">
                    <thead><tr><th>{t('tt.col.transition')}</th><th>{t('cmp.onlyIn', { x: 'A' })}</th><th>{t('cmp.onlyIn', { x: 'B' })}</th></tr></thead>
                    <tbody>
                      {cmp.transitionsChanged.map((c) => (
                        <tr key={c.a.key}>
                          <td><strong>{c.a.name}</strong><div className="small muted">{route(c.a, t)}</div>{c.fromChanged && <div className="small muted">B: {route(c.b, t)}</div>}</td>
                          <td className="small">{c.rulesOnlyA.map((r, i) => <div key={i}>[{r.vendor.name}] {describeRule(r, t.lang)}</div>)}</td>
                          <td className="small">{c.rulesOnlyB.map((r, i) => <div key={i}>[{r.vendor.name}] {describeRule(r, t.lang)}</div>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
