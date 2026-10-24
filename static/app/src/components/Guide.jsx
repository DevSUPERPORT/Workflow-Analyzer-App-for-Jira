import { useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useApp } from './common.jsx';
import { GUIDE } from '../lib/guide-content.js';
import Icon from './Icon.jsx';

// In-app tutorial: how to use the Workflow Analyzer safely in your space.
export default function Guide({ onTour }) {
  const t = useT();
  const { actions } = useApp();
  const content = GUIDE[t.lang] || GUIDE.en;
  const [open, setOpen] = useState(() => new Set([content.chapters[0].id]));
  const [done, setDone] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('superport.wfa.guideDone') || '[]')); } catch { return new Set(); }
  });
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const markDone = (id) => {
    const n = new Set(done);
    if (n.has(id)) n.delete(id); else n.add(id);
    setDone(n);
    try { localStorage.setItem('superport.wfa.guideDone', JSON.stringify([...n])); } catch { /* ignore */ }
  };
  const progress = Math.round((100 * content.chapters.filter((c) => done.has(c.id)).length) / content.chapters.length);

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 300px) 1fr', alignItems: 'start' }}>
      <div className="card" style={{ position: 'sticky', top: 'calc(var(--nav-h) + 16px)' }}>
        <h2 style={{ fontSize: 15 }}>{content.tocTitle}</h2>
        <div className="bar" style={{ marginBottom: 6 }}><span style={{ width: `${progress}%` }} /></div>
        <div className="small muted" style={{ marginBottom: 10 }}>{content.progress.replace('{n}', progress)}</div>
        {content.chapters.map((c, i) => (
          <button key={c.id} type="button" className="impact-item" aria-selected={open.has(c.id)} onClick={() => { setOpen(new Set([c.id])); document.getElementById(`guide-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
            <span className="step-no" data-done={done.has(c.id) || undefined}>{done.has(c.id) ? <Icon name="check" size={12} strokeWidth={2.5} /> : i + 1}</span>
            <span className="name" style={{ whiteSpace: 'normal' }}>{c.title}</span>
          </button>
        ))}
        <button type="button" className="btn small" style={{ marginTop: 14 }} onClick={onTour}><Icon name="play" size={12} />{t('tour.title')}</button>
      </div>

      <div>
        <section className="card">
          <h2>{content.title}</h2>
          <p style={{ margin: 0, maxWidth: '75ch' }}>{content.intro}</p>
        </section>
        <section className="card" style={{ background: 'var(--tile)', color: 'var(--tile-text)', borderColor: 'var(--tile)' }}>
          <h2 className="row" style={{ gap: 10 }}><Icon name="shieldCheck" size={20} style={{ color: 'var(--accent)' }} />{content.golden.title}</h2>
          <ol style={{ margin: 0, paddingLeft: 20, maxWidth: '75ch' }}>{content.golden.rules.map((r, i) => <li key={i} style={{ marginBottom: 6 }}>{r}</li>)}</ol>
        </section>
        {content.chapters.map((c, i) => {
          const isOpen = open.has(c.id);
          return (
            <div key={c.id} id={`guide-${c.id}`} className="sec" style={{ marginBottom: 8 }}>
              <button type="button" className={`sh ${isOpen ? 'open' : ''}`} style={{ position: 'static', width: '100%', border: 0, textAlign: 'left', font: 'inherit' }} onClick={() => toggle(c.id)} aria-expanded={isOpen}>
                <span className="caret"><Icon name="chevronRight" /></span>
                <span className="stit">{i + 1}. {c.title}</span>
                <span className="smet row" style={{ gap: 6 }}>{c.minutes} min{done.has(c.id) && <Icon name="check" size={14} style={{ color: 'var(--ok)' }} />}</span>
              </button>
              {isOpen && (
                <div style={{ padding: '12px 16px' }}>
                  {c.intro && <p>{c.intro}</p>}
                  <ol style={{ paddingLeft: 20 }}>
                    {c.steps.map((s, j) => (
                      <li key={j} style={{ marginBottom: 8 }}>
                        <strong>{s.title}</strong>
                        <div>{s.text}</div>
                        {s.tab && <button type="button" className="btn small" style={{ marginTop: 4 }} onClick={() => actions.setTab(s.tab)}>{content.open} {s.tabLabel}<Icon name="arrowRight" /></button>}
                      </li>
                    ))}
                  </ol>
                  {c.tip && <div className="note-box" style={{ marginBottom: 12 }}><strong>{content.tip}</strong> {c.tip}</div>}
                  {c.warning && <div className="alert"><Icon name="alert" size={18} /><span>{c.warning}</span></div>}
                  <label className="row" style={{ cursor: 'pointer' }}><input type="checkbox" checked={done.has(c.id)} onChange={() => markDone(c.id)} /> {content.markDone}</label>
                </div>
              )}
            </div>
          );
        })}
        <div className="card">
          <h3>{content.faq.title}</h3>
          {content.faq.items.map((f, i) => (
            <details key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{f.q}</summary>
              <p style={{ margin: '6px 0 0' }}>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
