# Data Security & Privacy answers: Workflow Analyzer & Autopilot for Jira

Answers for the Marketplace listing's *Privacy & Security* tab and the Atlassian security questionnaire, based on the code in this
repository (paths given). Draft of 23 Nov 2026.

## Hosting and data flow

| Question | Answer |
|---|---|
| Where does the app run? | Entirely on Atlassian Forge. **Runs on Atlassian**: the manifest declares no egress and no remote backends. |
| Does the app send data outside Atlassian? | **No.** No external `fetch`, no analytics, no third-party services; the UI loads no CDN assets. |
| AI | Optional and **off by default** (`src/lib/store.js` `getAiSettings`). When a Jira admin turns it on, prompts with the relevant workflow configuration and the user's question go to **Forge LLMs** (Claude, run by Atlassian, `src/lib/ai.js`) or to **Rovo**. Neither is a third party to the customer; nothing leaves Atlassian. AI output is labelled "AI-generated, please review" and never changes Jira without the user's confirmation. |
| Does the app store data outside Atlassian? | **No.** Everything is in Forge hosted storage (KVS) of the customer's installation. |
| Data residency | Forge hosted storage follows the host product's data residency location. |
| Sub-processors | None besides Atlassian. |
| Credentials | The app collects **no** credentials, API tokens or keys (questionnaire Q11: No). |

## What data the app stores (Forge KVS, per installation)

| Data | Contents | Personal data? |
|---|---|---|
| Change plans and backups | Operations, workflow name, health before/after, workflow backup for rollback, who created/applied/rolled back (`src/lib/plans.js`) | Account ID |
| Bulk plans | As above, for site-wide bulk changes (`src/lib/bulk.js`) | Account ID |
| Snapshots | Workflow configuration at a point in time, label, who saved it (`src/lib/store.js`, `src/shared/snapshot.js`) | Account ID |
| Team notes | Text per transition, author (`src/lib/store.js` `saveNote`) | Account ID; free text written by the team |
| Preferences, last visit | Language and UI preferences, last-seen markers (`pref-{accountId}`, `seen-…`) | Account ID in the key |
| AI switch | On/off, who changed it and when, last 50 changes (`ai-settings`) | Account ID |
| Monitoring, remediation tasks, resolution repair log | Project IDs, finding keys, issue keys changed, who did it | Account ID |
| AI usage meter | Calls, tokens and EUR per month (`llm-usage:YYYY-MM`) | No |

The app stores **account IDs only**, never display names, emails or other profile data: names are looked up from Jira when they
are shown (`src/lib/names.js`). It does **not** store issue content, comments, attachments or emails. Workflow configuration
copies (snapshots, rollback backups) can contain account IDs of users that Jira's workflow rules reference.

## Personal data handling

| Question | Answer |
|---|---|
| Which personal data? | Atlassian account IDs of users who create plans, notes or snapshots, run repairs or change the AI switch. |
| Personal Data Reporting API | **Implemented** (`src/lib/privacy.js`). A daily trigger (`personal-data-daily`, runs on every site, licensed or not) reports all stored account IDs to Atlassian at most once every 7 days. For accounts Atlassian reports as closed, the app deletes their preferences and visit markers and removes the account ID from every record (plans, notes, snapshots, logs); the content itself stays. Display names stored by versions before 23 Nov 2026 are removed once. Tested in `tests/privacy.test.js`. |
| Can a customer delete data? | Plans, snapshots and notes can be deleted in the app; uninstalling deletes all data (see below). |
| GDPR role | The customer is the controller; SUPERPORT doesn't receive the data. |

## Security controls

| Control | Implementation |
|---|---|
| Authentication | Forge-signed context only: the project page uses the project and account from Forge (`src/index.js`). Where a project key is given (Rovo actions, the site page), the user's own Jira permissions on that project are checked live before anything is read or changed. |
| Authorization | Every resolver re-checks the caller's Jira permissions (`src/lib/auth.js`): project admins for their project, Jira admins for the site page and company-managed workflows. |
| Changes | Only after explicit confirmation; validated by Jira before applying; a backup and snapshot are stored first; rollback refuses to overwrite later changes by colleagues. |
| AI controls | Off by default; only Jira admins switch it on; SUPERPORT's vendor stop and a monthly budget per site (20 € by default, `AI_BUDGET`, `src/lib/aiBudget.js`). |
| Licensing | Without an active Marketplace licence every resolver and Rovo action refuses (`src/lib/license.js`); the daily monitor runs only on licensed sites (`filter.appIsLicensed`). |
| Kill switch | SUPERPORT can make the app read-only or unavailable via `APP_MAINTENANCE` during incidents (`src/lib/maintenance.js`); customers see a notice and the status page link. |
| Encryption | In transit and at rest, provided by Atlassian Forge. |
| Tests | 190+ automated tests, including security (cross-project access, hostile payloads, prototype pollution, double apply, rate limits), the AI budget and the licence gate. |

## Uninstall and data deletion

When the app is uninstalled, Atlassian soft-deletes its Forge hosted storage and deletes it permanently after the retention period
(see Atlassian's [hosted storage data lifecycle](https://developer.atlassian.com/platform/forge/storage-reference/hosted-storage-data-lifecycle/)).
Workflow changes the customer applied stay in their Jira.

## Security contact and incidents

- Security reports: [mail@superport.digital](mailto:mail@superport.digital) (subject "Security")
- Status and incident communication: https://superapps.statuspage.io/
- Vendor: SUPERPORT P.C., Sorou 22, 151 25 Marousi (Athens), Greece · [App EULA & privacy policy](https://www.superport.digital/en/apps/eula)
