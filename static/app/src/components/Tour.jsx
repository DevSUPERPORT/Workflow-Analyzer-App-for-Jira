/**
 * Guided tour dialog that walks a first-time user through the main tabs and keyboard shortcuts; remembers per
 * browser that it was completed. While AI is effectively off, the assistant step uses a text without AI.
 *
 * @file        static/app/src/components/Tour.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-16
 */

import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n.jsx';
import { useAiOn } from './common.jsx';
import Icon from './Icon.jsx';
import appIcon from '../assets/app-icon.png';

// In tab order (App.jsx tabGroups)
const STEPS = ['welcome', 'overview', 'transitions', 'access', 'flow', 'impact', 'assistant', 'health', 'export'];
const KEY = 'superport.wfa.tourDone';

export function tourDone() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

export default function Tour({ onClose, onGoTab, mode }) {
  const t = useT();
  const aiOn = useAiOn();
  const steps = mode === 'site' ? STEPS.filter((s) => s !== 'flow') : STEPS;
  // Text key of a step: the assistant step promises no AI while AI is off
  const textKey = (s) => (s === 'assistant' && !aiOn ? 'assistantNoAi' : s);
  const [i, setI] = useState(0);
  const primary = useRef(null);
  const step = steps[i];
  const last = i === steps.length - 1;
  const close = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    onClose();
  };
  const go = (n) => {
    setI(n);
    if (steps[n] !== 'welcome') onGoTab(steps[n]);
  };
  useEffect(() => { primary.current?.focus(); }, [i]);
  return (
    <>
      <div className="drawer-backdrop" onClick={close} />
      <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <div className="tour-head">
          <img className="brand-icon" src={appIcon} alt="" width="40" height="40" />
          <div style={{ minWidth: 0 }}>
            <div className="small muted">{t('tour.title')} · {i + 1} / {steps.length}</div>
            <h2 id="tour-title" style={{ margin: 0 }}>{t(`tour.${textKey(step)}.title`)}</h2>
          </div>
        </div>
        <div className="tour-body view" key={step}>
          <p style={{ margin: 0, fontSize: 15, maxWidth: '62ch' }}>{t(`tour.${textKey(step)}.text`)}</p>
          {step === 'welcome' && (
            <div className="note-box small" style={{ marginTop: 16 }}>
              <strong>{t('tour.shortcuts')}</strong>: <kbd>/</kbd> {t('tour.kSearch')} · <kbd>Alt</kbd>+<kbd>1…9</kbd> {t('tour.kTabs')} · <kbd>?</kbd> {t('tour.kHelp')} · <kbd>Esc</kbd> {t('tour.kClose')}
            </div>
          )}
        </div>
        <div className="tour-foot">
          <div className="pips" aria-hidden="true">{steps.map((s, n) => <span key={s} className={n === i ? 'on' : n < i ? 'done' : ''} />)}</div>
          <button type="button" className="btn ghost small" onClick={close}>{t('tour.skip')}</button>
          {i > 0 && <button type="button" className="btn" onClick={() => go(i - 1)}>{t('tour.back')}</button>}
          {!last && <button ref={primary} type="button" className="btn primary" onClick={() => go(i + 1)}>{t('tour.next')}<Icon name="arrowRight" /></button>}
          {last && <button ref={primary} type="button" className="btn primary" onClick={close}><Icon name="check" />{t('tour.finish')}</button>}
        </div>
      </div>
    </>
  );
}
