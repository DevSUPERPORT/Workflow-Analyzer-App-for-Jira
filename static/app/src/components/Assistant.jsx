/**
 * AI assistant tab: the built-in Copilot chat on Forge LLMs, deterministic plain-language explanations of
 * workflows and transitions, and the hand-off to the Rovo "Workflow Analyst" agent when Rovo is enabled. While AI
 * is effectively off, the chat, the Rovo card and every "Ask Rovo" button are not rendered at all (no notice); the
 * deterministic explanations keep working and the tab is then labelled "Explanations".
 *
 * @file        static/app/src/components/Assistant.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { useEffect, useRef, useState } from 'react';
import { call } from '../lib/api.js';
import { rovo } from '@forge/bridge';
import { useT } from '../lib/i18n.jsx';
import { useApp, useAiOn, AiLabel, aiErrorText } from './common.jsx';
import { describeWorkflow, describeTransition } from '../../../../src/shared/explain.js';
import Icon from './Icon.jsx';
import Markdown from './Markdown.jsx';

export const AGENT = { type: 'forge', agentKey: 'workflow-analyst', agentName: 'Workflow Analyst' };

export async function openRovo(prompt) {
  if (!rovo?.open) return false;
  await rovo.open({ ...AGENT, prompt });
  return true;
}

export default function Assistant({ model, workflows }) {
  const t = useT();
  const { actions } = useApp();
  const aiOn = useAiOn();
  const [enabled, setEnabled] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [pick, setPick] = useState('');
  const key = model.project?.key || '';

  useEffect(() => {
    if (!aiOn) return undefined;
    let alive = true;
    (async () => {
      try {
        const ok = rovo?.isEnabled ? await rovo.isEnabled() : false;
        if (alive) setEnabled(!!ok);
      } catch {
        if (alive) setEnabled(false);
      }
    })();
    return () => { alive = false; };
  }, [aiOn]);

  const ask = async (text) => {
    if (!aiOn) return;
    try {
      await openRovo(text);
    } catch {
      setEnabled(false);
    }
  };

  const starters = model.kind === 'site' ? ['as.s2', 'as.s4'] : ['as.s1', 'as.s2', 'as.s3', 'as.s4'];
  const options = workflows.flatMap((wf) => wf.transitions.map((tr) => ({ wf, tr })));
  const picked = options.find((o) => o.tr.key === pick);

  return (
    <div className="grid two">
      <div>
        {model.kind === 'project' && aiOn && <AiChat model={model} workflows={workflows} />}
        {aiOn && (
          <section className="card">
            <h2 className="ai-badge" style={{ fontSize: 17 }}><Icon name="message" size={18} />{t('as.rovoTitle')}</h2>
            <p className="muted">{t('as.intro')}</p>
            {enabled === false && <div className="alert info"><Icon name="info" size={18} /><span>{t('app.rovoUnavailable')}</span></div>}
            <textarea aria-label={t('as.rovoPlaceholder')} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('as.rovoPlaceholder')} rows={3} style={{ width: '100%' }} disabled={enabled === false} />
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn primary" disabled={!enabled || !prompt.trim()} onClick={() => ask(key && !prompt.includes(key) ? `${prompt} (Project ${key})` : prompt)}><Icon name="send" />{t('as.rovoSend')}</button>
            </div>
            <h3 style={{ margin: '20px 0 8px' }}>{t('as.starters')}</h3>
            {starters.map((s) => (
              <button key={s} type="button" className="starter" disabled={enabled === false} onClick={() => ask(t(s, { key }))}><Icon name="sparkle" style={{ color: 'var(--accent)' }} /><span style={{ flex: 1 }}>{t(s, { key })}</span><Icon name="arrowRight" style={{ color: 'var(--text-muted)' }} /></button>
            ))}
          </section>
        )}
        <div className="card">
          <h3>{t('as.explainTransition')}</h3>
          <select aria-label={t('as.pickTransition')} value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: '100%' }}>
            <option value="">{t('as.pickTransition')}</option>
            {workflows.map((wf) => (
              <optgroup key={wf.id} label={wf.name}>
                {wf.transitions.map((tr) => <option key={tr.key} value={tr.key}>{tr.name} ({tr.from.map((f) => f.name).join(', ') || (tr.isInitial ? t('dg.start') : t('tt.any'))} → {tr.to?.name || t('tt.loop')})</option>)}
              </optgroup>
            ))}
          </select>
          {picked && (
            <div className="explain" style={{ marginTop: 10 }}>
              {describeTransition(picked.wf, picked.tr, t.lang, model.findings).map((l, i) => <p key={i}>{l}</p>)}
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn small" onClick={() => actions.openTransition(picked.tr.key)}>{t('tt.details')}</button>
                {aiOn && enabled === true && <button type="button" className="btn small" onClick={() => ask(`Explain the transition "${picked.tr.name}" in workflow "${picked.wf.name}"${key ? ` of project ${key}` : ''}.`)}><Icon name="sparkle" />{t('app.askRovo')}</button>}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <h2 className="ai-badge" style={{ fontSize: 17 }}><Icon name="sparkle" size={18} />{t('as.builtinTitle')}</h2>
        {workflows.map((wf) => (
          <div key={wf.id} className="explain">
            <p><strong>{wf.name}</strong></p>
            {describeWorkflow(model, wf, t.lang).map((l, i) => <p key={i}>{l}</p>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// Rendered only while AI is effectively on (see Assistant)
function AiChat({ workflows }) {
  const t = useT();
  const { actions, ai } = useApp();
  const [history, setHistory] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [history]);
  const send = async (question) => {
    const text = (question || q).trim();
    if (!text) return;
    setQ('');
    const next = [...history, { role: 'user', content: text }];
    setHistory(next);
    setBusy(true);
    try {
      const res = await call('aiAsk', { question: text, history, workflowId: workflows.length === 1 ? workflows[0].id : null, lang: t.lang });
      setHistory([...next, { role: 'assistant', content: res.answer, model: res.model }]);
    } catch (e) {
      const known = e?.code === 'AI_DISABLED' || e?.code === 'AI_LIMIT' || e?.code === 'AI_STOPPED';
      setHistory([...next, { role: 'assistant', content: known ? aiErrorText(t, e, ai) : `${t('ai.error')} (${e.message})`, error: true }]);
    } finally {
      setBusy(false);
    }
  };
  const chips = ['ai.q1', 'ai.q2', 'ai.q3'];
  return (
    <section className="card">
      <h2 className="ai-badge" style={{ fontSize: 17 }}><Icon name="sparkle" size={18} />{t('ai.title')}</h2>
      <p className="small muted" style={{ marginTop: 0 }}>{t('ai.intro')}</p>
      <div className="chat" aria-live="polite">
        {history.length === 0 && <div className="row">{chips.map((k) => <button key={k} type="button" className="chip ref" onClick={() => send(t(k))}>{t(k)}</button>)}</div>}
        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role === 'user' ? 'user' : 'ai'} ${m.error ? 'error' : ''}`} style={m.role === 'assistant' && !m.error ? undefined : { whiteSpace: 'pre-wrap' }}>
            {m.role === 'assistant' && !m.error && <AiLabel style={{ marginBottom: 6 }} />}
            {m.role === 'assistant' && !m.error ? <Markdown text={m.content} /> : m.content}
            {m.model && <div className="small muted" style={{ marginTop: 6 }}>{m.model}</div>}
          </div>
        ))}
        {busy && <div className="bubble ai" role="status"><span className="typing" aria-label={t('ap.thinking')}><i /><i /><i /></span></div>}
        <div ref={endRef} />
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="text" aria-label={t('ai.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={t('ai.placeholder')} style={{ flex: 1 }} disabled={busy} />
        <button type="button" className="btn primary" disabled={busy || !q.trim()} onClick={() => send()}><Icon name="send" />{t('ai.send')}</button>
      </div>
      <div className="small muted row" style={{ marginTop: 10 }}>{t('ai.changeHint')} <button type="button" className="btn small ghost" onClick={() => actions.setTab('autopilot')}><Icon name="sparkle" />Autopilot</button></div>
    </section>
  );
}
