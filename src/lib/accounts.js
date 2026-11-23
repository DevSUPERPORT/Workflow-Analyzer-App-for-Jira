/**
 * Registry of the accounts the app stores data for: one small entry `acct-{accountId}` per account, written
 * whenever an account ID is stored (preferences, visits, plans, notes, snapshots, logs, the AI switch). The weekly
 * personal data report (lib/privacy.js) reads only this registry instead of scanning all stored data.
 *
 * @file        src/lib/accounts.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-23
 * @updated     2026-11-23
 */

import { kvs } from '@forge/kvs';
import { getAppContext } from '@forge/api';

export const ACCOUNT_PREFIX = 'acct-';
const ID_RE = /^[A-Za-z0-9:._-]{1,128}$/;
export const accountKey = (id) => `${ACCOUNT_PREFIX}${id}`;

// One write per account and invocation is enough (a page load can store the same account several times)
let seen = { invocationId: null, ids: new Set() };

function invocation() {
  try { return getAppContext()?.invocationId || null; } catch { return null; }
}

/** Records that the app stores data for these accounts (now). Never throws. */
export async function registerAccounts(...ids) {
  const inv = invocation();
  if (!inv || seen.invocationId !== inv) seen = { invocationId: inv, ids: new Set() };
  const fresh = [...new Set(ids.flat())].filter((id) => typeof id === 'string' && ID_RE.test(id) && !seen.ids.has(id));
  const at = new Date().toISOString();
  await Promise.all(fresh.map(async (id) => {
    try {
      await kvs.set(accountKey(id), { id, at });
      if (inv) seen.ids.add(id);
    } catch (e) {
      console.warn('[accounts] could not register an account:', e?.message || e);
    }
  }));
}
