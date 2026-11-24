# Marketplace listing: Workflow Analyzer & Optimizer for Jira

Everything to paste into the Atlassian partner portal. Images are in this folder (see [README](README.md)).
All decisions are made; the listing is created only when SUPERPORT says so.

## Basics

| Field | Value |
|---|---|
| App name | Workflow Analyzer & Optimizer for Jira |
| App ID | `ari:cloud:ecosystem::app/66b30dff-8536-4de6-8630-65f355b28bcc` |
| Hosting | Cloud, Forge, **Runs on Atlassian** (no egress; data in Atlassian's Forge storage; AI through Forge LLMs and Rovo, both run by Atlassian) |
| Version to list | Production **4.0.0** (tag `workflow-analyzer-20261124-101629`) |
| Product | Jira (Jira Software, Jira Service Management, Jira Work Management; company-managed and team-managed projects) |
| Payment model | Paid via Atlassian (manifest `app.licensing.enabled: true`) |
| Categories | Admin tools; Workflow; Project management |
| Keywords | workflow, workflow analysis, workflow documentation, health check, impact analysis, dependencies, Jira admin, governance, audit, Rovo, AI |
| Vendor | SUPERPORT P.C. (IKE), Sorou 22, 151 25 Marousi (Athens), Greece · https://www.superport.digital |
| Support | mail@superport.digital · https://www.superport.digital/en/contact · +30 698 336 9006 · working days 9:00–18:00 Athens time (DE/EN/GR), first response within 1 business day |
| Status page | https://superapps.statuspage.io/ |
| Documentation URL | https://github.com/DevSUPERPORT/Workflow-Analyzer-App-for-Jira/blob/main/docs/USER-GUIDE.md (repository public since 2026-11-24) |
| Privacy policy URL | https://www.superport.digital/en/apps/eula (§1.1 covers all SUPERPORT apps on the Marketplace; its data-protection part matches this app: AI off by default, only Rovo and Forge LLM) |
| EULA URL | https://www.superport.digital/en/apps/eula |

## Tagline (max 80 characters)

> See every Jira workflow at a glance, find what breaks, and change it safely.

## Summary (max 250 characters)

> Analyse, document and safely change Jira workflows. A health check finds broken rules, impact analysis shows what depends on a group,
> field or app, and the Autopilot applies fixes with a preview, backup and one-click rollback.

## Highlights (3: title, short text, image 1840×900)

1. **Understand every workflow in minutes**
   Live from Jira: diagram, transition table, rules of Jira and third-party apps, and a health score per project or for the whole site.
   Export it all as HTML, PDF, CSV or JSON.
   Image: `screenshots/overview.png`
2. **Know the impact before you change anything**
   Find every transition that depends on a group, role, field, user, screen or app, before you delete a group or uninstall an app.
   The access simulator shows who can move an issue, and why not.
   Image: `screenshots/dependencies.png`
3. **Fix problems safely with the Autopilot**
   One click turns findings into a change plan. Jira validates it, you see the health score before and after, and every change is
   backed up with a one-click rollback. Optional AI turns plain-language requests into a plan.
   Image: `screenshots/autofix.png`

## More screenshots (gallery, in this order, with captions)

| File | Caption |
|---|---|
| `screenshots/health.png` | The health check finds broken references, inactive users, missing resolutions and risky rules, with a fix for each. |
| `screenshots/diagram.png` | The workflow diagram straight from Jira, with app rules and findings highlighted. |
| `screenshots/access.png` | The access simulator: which transitions a person can use, and why one is blocked. |
| `screenshots/aiplan.png` | Optional AI: describe a change in your own words and the Autopilot turns it into a plan you review first. |
| `screenshots/assistant.png` | Ask questions about your workflows. Answers use only this project's live analysis. |
| `screenshots/site.png` | Jira admins analyse every workflow on the site at once. |
| `screenshots/changes.png` | Snapshots and daily monitoring show exactly what changed in a workflow, and when. |
| `screenshots/export.png` | Complete documentation as HTML, PDF, CSV or JSON. |
| `screenshots/settings.png` | AI features are off by default. Jira admins switch them on and see this month's usage. |

Banner: `banner-1120x548.png`. Hero image: `hero-960x600.png`. Logo: `app-logo-144.png` (listing) and `app-logo-512.png` (large).
All screenshots come from the app's built-in English demo data (click-dummy `#demo=en`, `scripts/capture-marketplace.mjs`), so no
customer or test-site data appears in them.

## Description (long)

**Jira workflows grow until nobody knows what they do.** Conditions that reference deleted groups, users who left, Done transitions
that never set a resolution, rules of apps you no longer pay for. Workflow Analyzer & Optimizer for Jira reads your workflows live from Jira,
explains them in plain language, finds what is broken and helps you fix it safely.

**Understand** (Project settings → Apps → Workflow Analyzer; Jira admins also get a site-wide page)
- Diagram, transition table and every rule (conditions, validators, post functions), including rules of third-party apps.
- Plain-language explanations of each workflow and transition.
- Live issue flow: where work piles up, which statuses are never used.
- Export complete documentation as HTML, PDF, CSV or JSON.

**Check**
- Health check with a score: unreachable statuses, dead ends, deleted groups, inactive users, disabled rules, missing or wrong
  resolutions, licence-dependent app rules and more. Each finding comes with a recommendation.
- Dependencies: every transition that uses a group, role, field, user, screen, permission or app.
- Access simulator: who can run which transition, and why someone can't.
- Issue resolutions: find existing issues whose resolution doesn't match their status, and repair them.

**Change safely with the Autopilot**
- Fix findings automatically or start from a template. Every plan is validated by Jira before it can be applied.
- See the operations, a preview, the health score before and after, and any new findings.
- A backup and a snapshot are stored before every change; one click rolls it back.
- Shared workflows are flagged; company-managed workflows can only be changed by Jira admins.

**Optional AI (off by default)**
- Jira admins can switch on AI features: plan changes in plain language, ask questions about your workflows, bulk descriptions,
  and the "Workflow Analyst" Rovo agent.
- AI runs on Atlassian (Forge LLMs and Rovo). An AI budget is included in the subscription; nothing is sent outside Atlassian.

**Runs on Atlassian.** The app stores nothing outside Atlassian's cloud and sends no data anywhere else.

## Pricing (confirmed by SUPERPORT on 2026-11-24)

Set in the partner portal under *Pricing* (single and multi-instance the same). Atlassian bills annual subscriptions at 10× the
monthly price. In line with the other SUPERPORT apps (11–100 users: Screen $0.40, Custom Field $0.60, Group $0.80), one step above
Group because the app is broader and includes AI that SUPERPORT pays for.

| Users on the site | Price per user per month | Monthly total at the top of the tier |
|---|---|---|
| Up to 10 | **Free** | $0 |
| 11–100 | $1.00 | $100 |
| 101–250 | $0.70 | $205 |
| 251–1,000 | $0.40 | $505 |
| 1,001–2,500 | $0.15 | $730 |
| 2,501–5,000 | $0.10 | $980 |
| 5,001–7,500 | $0.06 | $1,130 |
| 7,501–10,000 | $0.05 | $1,255 |
| 10,001–15,000 | $0.04 | $1,455 |
| 15,001–25,000 | $0.03 | $1,755 |
| 25,001–35,000 | $0.02 | $1,955 |
| 35,001 and more | $0.01 | |

Note: every site, including free ones, can use up to 20 € of AI per month, which SUPERPORT pays (typical use is a few cents per
AI plan). App Status can lower the budget for individual sites (`sites`). Free trial: Atlassian's standard 30 days.

## Why the app needs each permission (scope justification)

| Scope | Why |
|---|---|
| `read:jira-work` | Read projects, workflows, statuses, transitions, rules, screens, fields, resolutions, roles and issue counts to build the analysis |
| `write:jira-work` | Only on explicit user action: create Jira tasks from findings ("Create Jira tasks") and repair the resolution of issues ("Review & repair") |
| `read:jira-user` | Check the signed-in user's permissions and show user and group names referenced in workflow rules (e.g. inactive users) |
| `manage:jira-configuration` | Workflows are site configuration in Jira: applying and rolling back Autopilot plans (`workflows/update`) needs this scope. Company-managed workflows only for Jira admins; every change is user-confirmed, validated by Jira and backed up |
| `storage:app` | The app's own data in Forge storage: change plans and backups, snapshots, notes, monitoring state, preferences, AI switch and usage meter |
| `report:personal-data` | Atlassian's Personal Data Reporting API: the app reports the account IDs it stores and deletes them when Atlassian reports an account as closed (GDPR) |

Also declared: the Forge LLM module (`llm`, model Claude) and the Rovo agent "Workflow Analyst". Both are AI features, off until a Jira
admin turns them on.

## Partner portal checklist

1. In the developer console, check *Distribution* (sharing on, personal data declaration) for the app.
2. Partner portal → *Create new app* → **Forge app** → production environment → paid via Atlassian.
3. Paste the texts above; upload logo, banner, hero, highlights and gallery screenshots.
4. Enter the pricing table; keep the 30-day trial.
5. Enter documentation, EULA and privacy URLs from the table above.
6. Fill in the *Privacy & Security* tab from [DATA_SECURITY_PRIVACY.md](DATA_SECURITY_PRIVACY.md) (the user ticks the attestations).
7. Security questionnaire: the app collects no credentials or API tokens (Q11: **No**). It stores account IDs only and uses the
   Personal Data Reporting API (`src/lib/privacy.js`).
8. **Stop before "Submit"** so SUPERPORT can review everything. The Publisher Agreement is ticked by SUPERPORT.
9. After approval: install from the Marketplace on superportdev (trial) and repeat the smoke test.
