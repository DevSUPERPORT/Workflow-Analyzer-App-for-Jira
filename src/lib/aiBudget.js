/**
 * Forge LLM budget set by SUPERPORT through the internal "App Status" app: the Forge environment variable AI_BUDGET
 * (same mechanism as the APP_MAINTENANCE kill switch in lib/maintenance.js: `forge variables set` + redeploy, read
 * only on the server). Pure: parsing and the per-site caps take no platform calls, so the mock UI and the tests use
 * them as they are.
 *
 * AI_BUDGET (kind "usage"), compact JSON:
 *   {"stop":false,"callsPerMonth":1000,"tokensPerMonth":2000000,"siteCaps":{"bigcorp.atlassian.net":{"callsPerMonth":5000}}}
 *   stop            boolean, default false; true = AI off on every site
 *   callsPerMonth   int 0..1,000,000, default MONTHLY_LLM_CALLS; 0 = AI off
 *   tokensPerMonth  int 0..1,000,000,000, default MONTHLY_LLM_TOKENS; 0 = AI off
 *   siteCaps        optional, site host (lowercase, no scheme) -> { callsPerMonth?, tokensPerMonth? }; a missing
 *                   field falls back to the app-wide value
 * Unset or empty -> defaults. Invalid JSON or an invalid shape -> defaults and one warning in the log (never throws).
 *
 * @file        src/lib/aiBudget.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

import { MONTHLY_LLM_CALLS, MONTHLY_LLM_TOKENS } from './aiLimits.js';

const VAR = 'AI_BUDGET';
const MAX_CALLS = 1_000_000;
const MAX_TOKENS = 1_000_000_000;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const DEFAULT_AI_BUDGET = Object.freeze({ stop: false, callsPerMonth: MONTHLY_LLM_CALLS, tokensPerMonth: MONTHLY_LLM_TOKENS, siteCaps: Object.freeze({}) });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/** The cap fields present in an object (absent ones are left out); throws on an invalid value. */
function caps(o, where) {
  const out = {};
  for (const [key, max] of [['callsPerMonth', MAX_CALLS], ['tokensPerMonth', MAX_TOKENS]]) {
    if (o[key] === undefined) continue;
    if (!intIn(o[key], max)) throw new Error(`${where}${key} must be an integer from 0 to ${max.toLocaleString('en-US')}`);
    out[key] = o[key];
  }
  return out;
}

/**
 * Parses the raw AI_BUDGET value. Never throws.
 * @returns {{ budget: { stop: boolean, callsPerMonth: number, tokensPerMonth: number, siteCaps: Record<string, { callsPerMonth?: number, tokensPerMonth?: number }> }, error: string | null }}
 */
export function parseAiBudget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { budget: DEFAULT_AI_BUDGET, error: null };
  try {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Error('not valid JSON');
    }
    if (!isObject(v)) throw new Error('must be a JSON object');
    if (v.stop !== undefined && typeof v.stop !== 'boolean') throw new Error('stop must be true or false');
    const top = caps(v, '');
    const siteCaps = Object.create(null);
    if (v.siteCaps !== undefined) {
      if (!isObject(v.siteCaps)) throw new Error('siteCaps must be an object');
      for (const [host, c] of Object.entries(v.siteCaps)) {
        if (!HOST.test(host)) throw new Error(`siteCaps key "${host.slice(0, 80)}" must be a lowercase site host without scheme, e.g. bigcorp.atlassian.net`);
        if (!isObject(c)) throw new Error(`siteCaps["${host}"] must be an object`);
        siteCaps[host] = caps(c, `siteCaps["${host}"].`);
      }
    }
    return { budget: { ...DEFAULT_AI_BUDGET, ...top, stop: v.stop === true, siteCaps }, error: null };
  } catch (e) {
    return { budget: DEFAULT_AI_BUDGET, error: e.message };
  }
}

let warnedFor = null;

/** The current budget from the app's Forge environment; an invalid value is logged once (per value) and ignored. */
export function aiBudget(env = process.env) {
  const raw = env?.[VAR];
  const { budget, error } = parseAiBudget(raw);
  if (error && warnedFor !== raw) {
    warnedFor = raw;
    console.warn(`[ai-budget] ${VAR} ignored (${error}); using the defaults (${MONTHLY_LLM_CALLS} calls, ${MONTHLY_LLM_TOKENS} tokens per month)`);
  }
  return budget;
}

/** Does any site have its own caps? Only then the site host has to be looked up. */
export const hasSiteCaps = (budget) => Object.keys(budget?.siteCaps || {}).length > 0;

/**
 * Caps for one site: the site's own values where set, the app-wide ones otherwise. A cap of 0 turns the AI off for
 * that site, like stop does for every site.
 * @param {string | null} host e.g. "bigcorp.atlassian.net" (case and a scheme are ignored); null = app-wide values
 * @returns {{ stop: boolean, callsPerMonth: number, tokensPerMonth: number }}
 */
export function effectiveCaps(budget = DEFAULT_AI_BUDGET, host = null) {
  const key = String(host || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');
  const site = key && budget.siteCaps && Object.hasOwn(budget.siteCaps, key) ? budget.siteCaps[key] : {};
  const callsPerMonth = site.callsPerMonth ?? budget.callsPerMonth;
  const tokensPerMonth = site.tokensPerMonth ?? budget.tokensPerMonth;
  return { stop: budget.stop === true || callsPerMonth === 0 || tokensPerMonth === 0, callsPerMonth, tokensPerMonth };
}
