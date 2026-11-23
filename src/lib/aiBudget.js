/**
 * Forge LLM budget set by SUPERPORT through the internal "App Status" app: the Forge environment variable AI_BUDGET
 * (same mechanism as the APP_MAINTENANCE kill switch in lib/maintenance.js: `forge variables set` + redeploy, read
 * only on the server). Pure: parsing and the per-site caps take no platform calls, so the mock UI and the tests use
 * them as they are.
 *
 * AI_BUDGET (kind "eur" of the App Status contract, SUPERPORT-OPS jira-app/src/aibudget.js), compact JSON:
 *   {"eurPerMonth":20,"eurPerUsd":1,"dailyPerPerson":60,"stop":false,"sites":{"bigcorp.atlassian.net":100},
 *    "callsPerMonth":1000,"tokensPerMonth":2000000,"siteCaps":{"bigcorp.atlassian.net":{"callsPerMonth":5000}}}
 *   eurPerMonth     number 0..1,000,000, default 20 (EUR_PER_MONTH): Forge LLM spend per site and calendar month (UTC)
 *                   in EUR, priced from the tokens Atlassian reports (PRICES); new calls stop at 98 %. 0 = AI off
 *   eurPerUsd       number 0.5..2, default 1: turns Atlassian's USD prices into EUR (1 = conservative)
 *   dailyPerPerson  int 1..500, default 60: accepted for the contract, not used by this app
 *   sites           optional, site host -> EUR per month for that site (overrides eurPerMonth)
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
 * @updated     2026-11-23
 */

import { MONTHLY_LLM_CALLS, MONTHLY_LLM_TOKENS } from './aiLimits.js';

const VAR = 'AI_BUDGET';
const MAX_CALLS = 1_000_000;
const MAX_TOKENS = 1_000_000_000;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_EUR = 1_000_000;

/** SUPERPORT's default Forge LLM spend per site and month (EUR) while AI_BUDGET doesn't set one. */
export const EUR_PER_MONTH = 20;
/** No new AI call starts from this share of the EUR budget (parallel calls may each pass the check). */
export const STOP_AT = 0.98;

export const DEFAULT_AI_BUDGET = Object.freeze({
  stop: false, callsPerMonth: MONTHLY_LLM_CALLS, tokensPerMonth: MONTHLY_LLM_TOKENS, siteCaps: Object.freeze({}),
  eurPerMonth: EUR_PER_MONTH, eurPerUsd: 1, dailyPerPerson: 60, sites: Object.freeze({}),
});

// Atlassian's Forge LLM price list (USD per 1M tokens, input / output). An unknown model is priced like the most
// expensive one, so the meter never under-counts.
export const PRICES = Object.freeze([
  [/opus/i, 5, 25],
  [/sonnet/i, 3, 15],
  [/haiku/i, 1, 5],
]);
export function priceOf(model) {
  const p = PRICES.find(([re]) => re.test(String(model || ''))) || [null, 5, 25];
  return { inUsd: p[1], outUsd: p[2] };
}
/** EUR for one answer: { inTok, outTok } priced for the model, converted with eurPerUsd. */
export function costEur(model, { inTok = 0, outTok = 0 } = {}, eurPerUsd = 1) {
  const p = priceOf(model);
  return ((inTok * p.inUsd + outTok * p.outUsd) / 1e6) * eurPerUsd;
}
const numIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

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
    for (const [key, lo, hi] of [['eurPerMonth', 0, MAX_EUR], ['eurPerUsd', 0.5, 2]]) {
      if (v[key] === undefined) continue;
      if (!numIn(v[key], lo, hi)) throw new Error(`${key} must be a number from ${lo} to ${hi.toLocaleString('en-US')}`);
      top[key] = v[key];
    }
    if (v.dailyPerPerson !== undefined) {
      if (!Number.isInteger(v.dailyPerPerson) || v.dailyPerPerson < 1 || v.dailyPerPerson > 500) throw new Error('dailyPerPerson must be an integer from 1 to 500');
      top.dailyPerPerson = v.dailyPerPerson;
    }
    const sites = Object.create(null);
    if (v.sites !== undefined) {
      if (!isObject(v.sites)) throw new Error('sites must be an object');
      for (const [host, eur] of Object.entries(v.sites)) {
        if (!HOST.test(host)) throw new Error(`sites key "${host.slice(0, 80)}" must be a lowercase site host without scheme, e.g. bigcorp.atlassian.net`);
        if (!numIn(eur, 0, MAX_EUR)) throw new Error(`sites["${host}"] must be a number from 0 to 1,000,000`);
        sites[host] = eur;
      }
    }
    const siteCaps = Object.create(null);
    if (v.siteCaps !== undefined) {
      if (!isObject(v.siteCaps)) throw new Error('siteCaps must be an object');
      for (const [host, c] of Object.entries(v.siteCaps)) {
        if (!HOST.test(host)) throw new Error(`siteCaps key "${host.slice(0, 80)}" must be a lowercase site host without scheme, e.g. bigcorp.atlassian.net`);
        if (!isObject(c)) throw new Error(`siteCaps["${host}"] must be an object`);
        siteCaps[host] = caps(c, `siteCaps["${host}"].`);
      }
    }
    return { budget: { ...DEFAULT_AI_BUDGET, ...top, stop: v.stop === true, siteCaps, sites }, error: null };
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
    console.warn(`[ai-budget] ${VAR} ignored (${error}); using the defaults (${EUR_PER_MONTH} EUR, ${MONTHLY_LLM_CALLS} calls, ${MONTHLY_LLM_TOKENS} tokens per month)`);
  }
  return budget;
}

/** Does any site have its own caps or EUR budget? Only then the site host has to be looked up. */
export const hasSiteCaps = (budget) => Object.keys(budget?.siteCaps || {}).length > 0 || Object.keys(budget?.sites || {}).length > 0;

/**
 * Caps for one site: the site's own values where set, the app-wide ones otherwise. A cap of 0 turns the AI off for
 * that site, like stop does for every site.
 * @param {string | null} host e.g. "bigcorp.atlassian.net" (case and a scheme are ignored); null = app-wide values
 * @returns {{ stop: boolean, callsPerMonth: number, tokensPerMonth: number }}
 */
const hostKey = (host) => String(host || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '');

export function effectiveCaps(budget = DEFAULT_AI_BUDGET, host = null) {
  const key = hostKey(host);
  const site = key && budget.siteCaps && Object.hasOwn(budget.siteCaps, key) ? budget.siteCaps[key] : {};
  const callsPerMonth = site.callsPerMonth ?? budget.callsPerMonth;
  const tokensPerMonth = site.tokensPerMonth ?? budget.tokensPerMonth;
  return { stop: budget.stop === true || callsPerMonth === 0 || tokensPerMonth === 0, callsPerMonth, tokensPerMonth };
}

/**
 * Everything that applies on one site: the calls / tokens caps (effectiveCaps) plus the EUR budget (the site's own
 * value from `sites`, else eurPerMonth) and the USD rate. A budget of 0 EUR turns the AI off like a cap of 0.
 * @returns {{ stop: boolean, callsPerMonth: number, tokensPerMonth: number, eurPerMonth: number, eurPerUsd: number }}
 */
export function siteBudget(budget = DEFAULT_AI_BUDGET, host = null) {
  const caps = effectiveCaps(budget, host);
  const key = hostKey(host);
  const sites = budget.sites || {};
  const eur = key && Object.hasOwn(sites, key) ? sites[key] : budget.eurPerMonth ?? EUR_PER_MONTH;
  return { ...caps, stop: caps.stop || eur === 0, eurPerMonth: eur, eurPerUsd: budget.eurPerUsd ?? 1 };
}

/**
 * Input / output tokens to price one answer. What Atlassian reports; where it reports nothing, a generous estimate
 * (about 3 characters per token) so the EUR meter never under-counts.
 */
export function pricedTokens(usage, promptChars = 0, answerChars = 0) {
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  const i = n(usage?.input_tokens ?? usage?.prompt_tokens);
  const o = n(usage?.output_tokens ?? usage?.completion_tokens);
  return { inTok: i ?? Math.ceil(promptChars / 3), outTok: o ?? Math.ceil(answerChars / 3) };
}
