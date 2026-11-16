/**
 * Thin wrapper around the Forge bridge invoke: unwraps the { ok, data } shape of the resolvers into values or
 * ApiError. It also mirrors the server's kill switch: refusals are passed to the app (toast or full-page
 * notice), and background bookkeeping is skipped quietly while changes are paused.
 *
 * @file        static/app/src/lib/api.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { invoke } from '@forge/bridge';

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

// SUPERPORT's kill switch is decided on the server (APP_MAINTENANCE); the UI only mirrors what the server says.
// Background bookkeeping (language preference, visit tracking) is skipped quietly while changes are paused, so
// switching the language never shows a "paused" message.
const BACKGROUND = new Set(['setPrefs', 'touchVisit']);
const maintenance = { mode: 'off', onRefused: null };

export function setMaintenanceMode(mode) {
  maintenance.mode = mode;
}

/**
 * Called whenever the server refuses a call because of the kill switch. Receives the error (with `mode`), the
 * resolver name and whether it was background bookkeeping; may return the user-facing text for the error.
 */
export function onMaintenanceRefusal(fn) {
  maintenance.onRefused = fn;
}

export async function call(name, payload = {}) {
  if (maintenance.mode === 'readonly' && BACKGROUND.has(name)) {
    const e = new ApiError('UNAVAILABLE');
    e.mode = 'readonly';
    throw e;
  }
  const res = await invoke(name, payload);
  if (!res || res.ok !== true) {
    const e = new ApiError(res?.error || 'FAILED', res?.message, res?.status);
    if (e.code === 'UNAVAILABLE') {
      e.mode = res.mode === 'readonly' ? 'readonly' : 'on';
      const text = maintenance.onRefused?.(e, name, BACKGROUND.has(name));
      if (text) e.message = text;
    }
    throw e;
  }
  return res.data;
}
