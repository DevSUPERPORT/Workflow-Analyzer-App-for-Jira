/**
 * The effective AI state of the Custom UI, derived from data the app already loads (bootstrap): AI counts as on
 * only when the site's switch is on AND the app vendor has not stopped the AI. Anything else – no data, an error,
 * an older backend, a value that is not exactly true – counts as off. While AI is off the UI shows no AI entry
 * point at all (hidden, not greyed out); the server refuses AI requests on its own anyway.
 * Pure (no React, no bridge) so the tests can use it as it is.
 *
 * @file        static/app/src/lib/aiState.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

export const AI_OFF = Object.freeze({ enabled: false, stopped: false });

/**
 * Effective AI state from a bootstrap response (`{ ai: { enabled, stopped } }`).
 * @param {object | null | undefined} boot bootstrap data; null/undefined or an Error = off
 * @returns {{ enabled: boolean, stopped: boolean }}
 */
export function effectiveAi(boot) {
  if (!boot || typeof boot !== 'object' || boot instanceof Error) return AI_OFF;
  const ai = boot.ai;
  if (!ai || typeof ai !== 'object') return AI_OFF;
  const stopped = ai.stopped === true;
  return { enabled: ai.enabled === true && !stopped, stopped };
}

/** Effective state from an AppContext `ai` value (`{ enabled, stopped }`); missing = off. */
export const isAiOn = (ai) => ai?.enabled === true && ai?.stopped !== true;

/** Minimum time between two re-checks when the page gets focus or becomes visible again. */
export const AI_RECHECK_MS = 15_000;

/**
 * Re-fetches the effective AI state (e.g. after a Jira admin changed the switch in another tab). Errors count as
 * off, as at start-up.
 * @param {() => Promise<object>} fetchBootstrap e.g. () => call('bootstrap')
 */
export async function fetchEffectiveAi(fetchBootstrap) {
  try {
    return effectiveAi(await fetchBootstrap());
  } catch {
    return AI_OFF;
  }
}
