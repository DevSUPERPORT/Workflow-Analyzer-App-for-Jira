// Vendor (app) detection for workflow rules.
// Jira Cloud's workflow API encodes the rule origin in the ruleKey:
//   system:*  -> Atlassian (Jira built-in)
//   connect:* -> Connect app, parameters.appKey identifies the app
//   forge:*   -> Forge app, parameters.key is an extension ARI containing the appId

const KNOWN_APPS = [
  { test: /jmwe|innovalog/i, name: 'JMWE', vendor: 'Appfire' },
  { test: /jsu|beecom/i, name: 'JSU', vendor: 'Appfire' },
  { test: /groovyrunner|scriptrunner|onresolve|adaptavist/i, name: 'ScriptRunner', vendor: 'Adaptavist' },
  { test: /workflow-?enhancer|enhancer/i, name: 'Workflow Enhancer', vendor: 'Decadis' },
  { test: /workflowtoolbox|workflow-toolbox|jwt|decadis/i, name: 'Jira Workflow Toolbox', vendor: 'Decadis' },
  { test: /power-?scripts|cprime|kepler/i, name: 'Power Scripts', vendor: 'Appfire' },
  { test: /proforma|thinktilt/i, name: 'ProForma', vendor: 'Atlassian' },
  { test: /automation|codebarrel/i, name: 'Automation', vendor: 'Atlassian' },
  { test: /tempo/i, name: 'Tempo', vendor: 'Tempo' },
  { test: /xray|xpand/i, name: 'Xray', vendor: 'Xpand IT' },
  { test: /zephyr|smartbear/i, name: 'Zephyr', vendor: 'SmartBear' },
  { test: /structure|almworks/i, name: 'Structure', vendor: 'Tempo' },
  { test: /deviniti|issue-?templates/i, name: 'Deviniti', vendor: 'Deviniti' },
  { test: /refined/i, name: 'Refined', vendor: 'Refined' },
  { test: /herocoders|checklist/i, name: 'Checklist', vendor: 'HeroCoders' },
  { test: /jexo|elements|valiantys/i, name: 'Elements', vendor: 'Elements' },
];

export const JIRA_VENDOR = { key: 'jira', name: 'Jira', type: 'jira', thirdParty: false };

function prettifyKey(key) {
  const last = String(key || '').split(/[.:/]/).filter(Boolean).pop() || String(key || '?');
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b(cloud|jira|plugin|app|addon)\b/gi, '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || String(key);
}

// Extract the Forge appId from an extension ARI:
// ari:cloud:ecosystem::extension/{appId}/{environmentId}/static/{moduleKey}
export function forgeAppIdFromKey(key) {
  const m = /extension\/([0-9a-f-]{36})\//i.exec(String(key || ''));
  return m ? m[1] : null;
}

export function forgeModuleFromKey(key) {
  const m = /\/static\/([^/]+)$/i.exec(String(key || ''));
  return m ? m[1] : null;
}

/**
 * Resolve the vendor of a workflow rule.
 * @param {string} ruleKey
 * @param {object} params rule parameters
 * @param {object} capabilities optional /workflows/capabilities response
 */
export function detectVendor(ruleKey, params = {}, capabilities = null) {
  params = params && typeof params === 'object' ? params : {};
  const rk = String(ruleKey || '');
  if (rk.startsWith('system:') || /^com\.atlassian\.jira\./.test(rk)) return JIRA_VENDOR;

  if (rk.startsWith('connect:')) {
    // appKey parameter first; otherwise Jira's capability list or the key embedded in the rule key (older data)
    const cap = capabilities?.connectRules?.find((c) => c.ruleKey === rk);
    const fromKey = rk.slice(8).split('__')[0];
    const appKey = params.appKey || params.addonKey || cap?.addonKey || (fromKey.includes('.') ? fromKey : '') || '';
    const known = KNOWN_APPS.find((a) => a.test.test(appKey));
    return {
      key: `connect:${appKey || 'unknown'}`,
      appKey,
      name: known ? known.name : prettifyKey(appKey || 'Connect app'),
      maker: known ? known.vendor : null,
      type: 'connect',
      thirdParty: true,
    };
  }

  if (rk.startsWith('forge:')) {
    const appId = forgeAppIdFromKey(params.key);
    const forgeRule = capabilities?.forgeRules?.find((r) => appId && String(r.id || '').includes(appId));
    const label = forgeRule?.name ? forgeRule.name.replace(/\s*\(.*\)\s*$/, '') : null;
    const known = KNOWN_APPS.find((a) => a.test.test(`${params.key || ''} ${forgeRule?.name || ''}`));
    return {
      key: `forge:${appId || 'unknown'}`,
      appKey: appId,
      name: known ? known.name : label || `Forge app ${appId ? appId.slice(0, 8) : ''}`.trim(),
      maker: known ? known.vendor : null,
      type: 'forge',
      thirdParty: true,
    };
  }

  // Legacy / unmapped keys (e.g. migrated server class names)
  const known = KNOWN_APPS.find((a) => a.test.test(rk));
  if (known) return { key: `legacy:${known.name}`, name: known.name, maker: known.vendor, type: 'connect', thirdParty: true };
  return { key: 'other', name: 'Other', type: 'other', thirdParty: false };
}

// Superport-friendly palette for vendor chips (Jira stays neutral, apps get distinct accents)
const PALETTE = ['#E34B04', '#2F6FDE', '#2D8A57', '#8E44AD', '#C2185B', '#00897B', '#B7791F', '#5D6D7E', '#D35400', '#1F618D'];
export function vendorColor(vendorKey, allKeys = []) {
  if (!vendorKey || vendorKey === 'jira') return '#6B6A67';
  const sorted = [...new Set(allKeys.filter((k) => k !== 'jira'))].sort();
  const i = sorted.indexOf(vendorKey);
  let h = 0;
  for (const c of String(vendorKey)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[(i >= 0 ? i : h) % PALETTE.length];
}
