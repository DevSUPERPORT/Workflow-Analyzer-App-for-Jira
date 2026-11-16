/**
 * React side of the shared dictionary: the language context, the useT hook with date formatting, and the
 * per-browser language choice in localStorage.
 *
 * @file        static/app/src/lib/i18n.jsx
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { createContext, useContext } from 'react';
import { t as translate, formatDate } from '../../../../src/shared/i18n.js';

export const LangContext = createContext('en');

export function useLang() {
  return useContext(LangContext);
}

export function useT() {
  const lang = useContext(LangContext);
  const t = (key, vars) => translate(lang, key, vars);
  t.lang = lang;
  t.date = (iso, withTime) => formatDate(lang, iso, withTime);
  return t;
}

const STORAGE_KEY = 'superport.wfa.lang';

export function readStoredLang() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'de' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export function storeLang(lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage not available in this frame */
  }
}
