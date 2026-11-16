/**
 * Default monthly Forge LLM quota per installation (Jira site). Forge LLM usage is billed to SUPERPORT, the app
 * vendor, not to the customer: these limits keep the cost per site bounded. SUPERPORT sets the live limits (app-wide,
 * per site, or a full stop) through the App Status app in the Forge variable AI_BUDGET (lib/aiBudget.js); these
 * numbers apply while AI_BUDGET is unset or invalid. Every AI entry point (in-app chat, "Plan with AI", Bulk
 * "Describe (AI)", Rovo plan-workflow-change) goes through lib/ai.js and is counted per calendar month (UTC).
 *
 * @file        src/lib/aiLimits.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-11-16
 * @updated     2026-11-16
 */

/** Default Forge LLM calls per installation and calendar month (UTC), unless AI_BUDGET sets other limits. */
export const MONTHLY_LLM_CALLS = 1000;

/** Default Forge LLM tokens (prompt + completion) per installation and calendar month (UTC), unless AI_BUDGET sets other limits. */
export const MONTHLY_LLM_TOKENS = 2_000_000;
