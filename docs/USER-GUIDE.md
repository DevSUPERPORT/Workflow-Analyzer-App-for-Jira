# Anleitung: Den Workflow-Analyzer sicher nutzen

Diese Anleitung führt Sie von der ersten Analyse bis zu sicheren, KI-gestützten Workflow-Änderungen. Lesen und Analysieren verändert nie etwas in Jira – nur ein Autopilot-Plan, den Sie ausdrücklich übernehmen.

## ⚠ Goldene Regeln für die sichere Nutzung

1. Analysieren ist immer sicher: Übersicht, Diagramm, Transitionen, Abhängigkeiten, Zugriff, Fluss, Prüfung, Vergleich und Export lesen nur Daten.
2. Jira wird nur geändert, wenn Sie es bestätigen: durch einen Autopilot-Plan nach „In Jira übernehmen“ oder durch die Reparatur von Vorgangslösungen nach „Ja, reparieren“ – nie automatisch, nie durch die KI allein.
3. Jeden Plan vor dem Übernehmen lesen: Operationen (✓/✕), Vorschau der Änderungen, Health-Score vorher/nachher und neue Befunde.
4. Größere Änderungen zuerst in einem Test-Space ausprobieren (z. B. Kopie des Projekts), bevor ein produktiver Workflow geändert wird.
5. Auf den Hinweis „gemeinsam genutzter Workflow“ achten: Die Änderung betrifft jedes aufgeführte Projekt.
6. Jede Übernahme speichert einen Snapshot und eine Sicherung – wissen Sie, wo „Zurücksetzen“ ist (Autopilot › Plan).
7. In Regeln Projektrollen und Gruppen statt einzelner Benutzer verwenden.
8. Exporte enthalten Namen von Benutzern, Gruppen und Feldern – nur intern weitergeben.

## 1. Erste Schritte

Die App liest Ihre Workflows live aus Jira – kein XML-Export und kein Feld-Mapping mehr nötig.

1. **Analyzer öffnen** – Projekteinstellungen › Workflow-Analyzer (Projektadministratoren). Jira-Administratoren finden zusätzlich eine instanzweite Analyse unter Jira-Einstellungen › Apps › Workflow-Analyzer (instanzweit).
2. **Sprache wählen** – DE / EN oben rechts. Ihre Auswahl wird für Ihren Benutzer gespeichert.
3. **Tour starten** – Der „?“-Button startet eine einminütige Tour. Tastenkürzel: „/“ Suche, Alt+1…9 Tabs, Esc schließt Fenster.
4. **Workflow wählen** – Nutzt das Projekt mehrere Workflows, wählen Sie einen im Feld „Workflow“ – oder behalten „Alle Workflows“.

> 💡 Tipp: Mit dem Suchfeld oben springen Sie direkt zu jedem Status, jeder Transition, Gruppe, jedem Feld oder jeder App.

## 2. Workflows verstehen

1. **Übersicht** – Health-Score, Workflows, Regeln, Abhängigkeiten und Apps auf einen Blick, ein priorisierter Maßnahmenplan und die Prüfung je Bereich.
2. **Diagramm** – Status anklicken hebt seine Wege hervor, Transition anklicken zeigt Details. Ebenen zeigen Vorgangslast, Persona-Zugriff oder die Auswirkung einer Gruppe/App.
3. **Transitionen** – Die gewohnte Tabelle: Bedingungen, Validierungen und Post-Functions in Klartext. Nach App (JMWE, JSU, ScriptRunner …) oder Element filtern, suchen und Team-Notizen ergänzen.
4. **Transitionsdetails** – Ein Klick auf den Transitionsnamen erklärt, wer sie ausführen darf, was geprüft wird und was danach passiert.

## 3. Auswirkungen prüfen, bevor Sie etwas ändern

1. **Abhängigkeiten** – Bevor Sie eine Gruppe löschen, eine App deinstallieren, ein Feld umbenennen oder einen Benutzer deaktivieren: Eintrag auswählen und alle betroffenen Transitionen sehen. Rote Einträge existieren auf der Instanz nicht mehr.
2. **Zugriffssimulator** – „Warum kann dieser Benutzer das Ticket nicht weiterschieben?“: Gruppen/Rollen der Person auswählen und erlaubte, gesperrte und datenabhängige Transitionen sehen. Der Wegfinder zeigt, wie ein Vorgang von A nach B kommt.
3. **Live-Fluss** – Live-Vorgangszahlen laden, um Engpässe, liegengebliebene Arbeit und nie genutzte Status zu finden – wichtig, bevor ein Status entfernt wird.

> 💡 Tipp: Mit „Im Diagramm zeigen“ sehen Sie die Auswirkung einer Gruppe oder App direkt im Workflow-Graphen.

## 4. Workflows sicher mit dem Autopilot ändern

Der Autopilot macht aus Ihrer Anfrage einen Plan. Es ändert sich nichts, bevor Sie den Plan übernehmen.

1. **1. Änderung beschreiben** – Beschreiben Sie in eigenen Worten und mit genauen Namen, was Sie brauchen, z. B. „Status Eskaliert anlegen, erreichbar aus Prüfung, nur für die Rolle Administrators, mit Rückweg“. Oder Vorlage bzw. „Befunde automatisch beheben“ nutzen. Das freie Beschreiben nutzt die KI und steht nur zur Verfügung, wenn die KI-Funktionen eingeschaltet sind (Kapitel 5); „Befunde automatisch beheben“ und die Vorlagen funktionieren immer.
2. **2. Plan prüfen** – Jede Operation prüfen (✓ = möglich, ✕ = nicht möglich und wird übersprungen), die Vorschau der hinzugefügten/entfernten/geänderten Elemente, den Health-Score vorher → nachher und neue Befunde.
3. **3. Betroffene prüfen** – Wird der Workflow von anderen Projekten mitgenutzt, listet der Plan sie auf. Nur übernehmen, wenn die Änderung für alle passt – oder den Jira-Admin bitten, dem Projekt zuerst einen eigenen Workflow zu geben.
4. **4. Übernehmen** – „In Jira übernehmen“ prüft den Plan gegen die aktuelle Version, lässt Jira validieren, speichert Snapshot und Sicherung und aktualisiert dann den Workflow. Unternehmensverwaltete Workflows erfordern Jira-Administrator-Rechte.
5. **5. Kontrollieren** – Tabs Diagramm und Prüfung öffnen und die geänderte Transition mit einem Testvorgang ausprobieren.
6. **6. Bei Bedarf zurücksetzen** – Autopilot › Plan auswählen › „Zurücksetzen“ stellt den Workflow exakt wie vorher wieder her.

> ⚠ Beim Entfernen eines Status werden dessen Vorgänge in den gewählten Status verschoben; ein Rollback stellt den Status wieder her, aber nicht den vorherigen Status dieser Vorgänge. App-Regeln (JMWE, ScriptRunner …) kann der Autopilot nicht bearbeiten – ändern Sie diese in der jeweiligen App.

## 5. Mit KI arbeiten (Copilot & Rovo)

Die KI-Funktionen (KI-Chat, „Mit KI planen“, Bulk „Beschreiben (KI)“ und der Rovo-Agent) sind **standardmäßig deaktiviert**. Nur Jira-Administratoren (globale Berechtigung „Jira verwalten“) können sie einschalten: Jira-Einstellungen › Apps › Workflow-Analyzer (instanzweit) › Karte bzw. Tab „Einstellungen“ › **KI-Funktionen** › „Aktivieren“. Dort sehen sie auch den KI-Verbrauch dieses Monats. Solange die KI aus ist – oder vom App-Anbieter vorübergehend ausgeschaltet wurde –, blendet die App alle KI-Funktionen vollständig aus: kein KI-Chat, kein „Mit KI planen“, kein „Im Rovo-Chat planen“, kein „Mit KI beheben“, keine „Rovo fragen“-Buttons und keine Vorlage „Beschreiben (KI)“; dieses Kapitel und die KI-Hinweise in Tour und Anleitung erscheinen dann ebenfalls nicht, und der Tab „KI-Assistent“ heißt „Erklärungen“. Alle Funktionen ohne KI (Analyse, Vorlagen, „Befunde automatisch beheben“, Erklärungen in Klartext, Prüfen, Übernehmen und Zurücksetzen von Plänen) bleiben unverändert. Sobald ein Jira-Administrator die KI einschaltet, erscheinen die Funktionen nach dem Neuladen der Seite oder spätestens, wenn Sie zur geöffneten App zurückkehren.

1. **Fragen stellen** – KI-Assistent › „Fragen Sie Ihre Workflows“ antwortet mit der Live-Analyse dieses Projekts. Die KI läuft auf Atlassian (Forge LLMs) – Ihre Daten bleiben in der Atlassian Cloud.
2. **Rovo-Agent „Workflow Analyst“** – Im Rovo-Chat erhalten Sie Übersichten, Verwendungen, Prüfungen und Zugriffsanalysen – und können Änderungen planen und übernehmen lassen. Vor jeder Änderung zeigt der Agent den Plan und fragt nach Bestätigung.
3. **Gute Anfragen schreiben** – Workflow, genaue Status-/Transitionsnamen und Gruppen oder Rollen nennen. Eine Änderung pro Anfrage ergibt die klarsten Pläne.

> ⚠ Die KI kann eine Anfrage missverstehen. Lesen Sie vor dem Übernehmen immer die Liste der Operationen.

## 6. Befunde beheben und Arbeit verfolgen

1. **Prüfung** – Jeder Befund hat eine Empfehlung. „Transition anzeigen“ springt zur Ursache.
2. **Automatisch beheben** – Autopilot › „Befunde automatisch beheben“ erstellt einen prüfbaren Plan für automatisch behebbare Befunde und listet den Rest zur manuellen Nacharbeit.
3. **Jira-Aufgaben** – „Jira-Aufgaben erstellen“ macht aus Befunden Aufgaben (Labels workflow-health, superport-wfa) – Duplikate werden übersprungen.
4. **Lösungen der Vorgänge** – Eine Workflow-Korrektur wirkt nur für künftige Transitionen. Prüfung › „Lösungen der Vorgänge“ zeigt Vorgänge, die erledigt, aber ungelöst sind (Berichte zählen sie als offen), und offene Vorgänge mit Lösung. „Prüfen & reparieren“ listet alle mit einem Vorschlag je Status (z. B. „Nicht genehmigt“ → Won’t Do); nach Bestätigung wird das Feld Lösung gesetzt (für Jira-Admins ohne Benachrichtigungen) oder über die Workflow-Transition in den aktuellen Status geleert – der Status bleibt in beiden Fällen. Jira kann eine gesetzte Lösung nicht zurücknehmen, ohne den Vorgang zu verschieben; daher die Auswahl prüfen. Das Leeren lässt sich rückgängig machen. Jeder Lauf steht im Reparatur-Verlauf, und inzwischen geänderte Vorgänge werden nie überschrieben.

## 7. Überwachung und Änderungsverlauf

1. **Snapshots** – Änderungen › „Snapshot speichern“ vor größeren Änderungen; später zeigt „Mit aktuellem Stand vergleichen“ genau, was sich geändert hat.
2. **Tägliche Überwachung** – Einmal pro Projekt aktivieren: Die App prüft täglich, speichert bei jeder Änderung einen Snapshot und zeigt beim nächsten Besuch einen Hinweis.

## 8. Dokumentieren und teilen

1. **Export** – HTML (interaktive Einzeldatei, auch für das Confluence-HTML-Makro), PDF (druckfertig), CSV (Excel) und JSON. Kunden-Kürzel und Workflow-Bezeichnung steuern wie gewohnt den Dateinamen.
2. **Verantwortungsvoll teilen** – Exporte enthalten Benutzer-, Gruppen- und Feldnamen. Nur in internen Bereichen ablegen.

## 9. Plattformgrenzen

Die App läuft auf Atlassian Forge. Atlassian begrenzt für alle Forge-Apps Rechenzeit, Speicher, Aufrufe und API-Anfragen (Quoten und Rate Limits); für die KI-Funktionen gelten zusätzlich die Grenzen der Forge LLMs bzw. von Rovo.

1. **Große Workflows** – Analysen sehr großer Workflows oder vieler Projekte können länger dauern.
2. **KI nicht verfügbar** – Ist die KI für Ihre Site gerade nicht verfügbar oder ein Kontingent erreicht, zeigt die App das an. Alle Funktionen ohne KI laufen weiter.
3. **Monatliches KI-Kontingent** – Die Grenzen legt SUPERPORT als App-Anbieter fest, für alle Sites oder für einzelne Sites. Standard je Jira-Site und Kalendermonat (UTC): ein KI-Budget von 20 €, höchstens 1.000 KI-Anfragen und 2.000.000 Tokens (KI-Chat, „Mit KI planen“, Bulk „Beschreiben (KI)“ und Planungen des Rovo-Agenten zusammen). Das Budget ist im Abonnement enthalten; es entstehen Ihnen keine zusätzlichen Kosten. Ist eines davon aufgebraucht, meldet die App „Das monatliche KI-Kontingent ist aufgebraucht. Es steht ab dem 1. des nächsten Monats wieder zur Verfügung.“ Jira-Administratoren sehen den Verbrauch und die für ihre Site geltenden Grenzen neben dem Schalter „KI-Funktionen“. Schaltet SUPERPORT die KI vorübergehend aus, meldet die App „Die KI-Funktionen sind vorübergehend vom App-Anbieter ausgeschaltet. Bitte versuchen Sie es später erneut.“; Ihre Einstellung bleibt gespeichert.
4. **App-Status und Wartung** – Muss SUPERPORT die App für Wartungsarbeiten oder bei einem Sicherheitsproblem pausieren, zeigt sie „vorübergehend nicht verfügbar“ oder einen Hinweis, dass Änderungen pausiert sind (Ansehen funktioniert weiter). Den aktuellen Stand zeigt die Statusseite https://superapps.statuspage.io.
5. **Abbruch** – Wird eine Grenze während einer Änderung erreicht, zeigt die App einen Fehler. Prüfen Sie im Änderungsverlauf, was übernommen wurde, und wiederholen Sie den Rest etwas später.

## Häufige Fragen

**Kann die Analyse etwas kaputt machen?**

Nein. Alle Tabs außer den Autopilot-Buttons „In Jira übernehmen“ und „Zurücksetzen“, „Jira-Aufgaben erstellen“, „Überwachung aktivieren“ und die Reparatur von Vorgangslösungen lesen nur Daten.

**Warum steht im Zugriffssimulator „abhängig“?**

Das Ergebnis hängt von Daten des konkreten Vorgangs (Feldwerte, Historie) oder von App-Bedingungen ab, die erst zur Laufzeit geprüft werden.

**Warum kann ich einen Plan nicht übernehmen?**

Unternehmensverwaltete Workflows dürfen nur Jira-Administratoren ändern. Bei gemeinsam genutzten Workflows zuerst den Hinweis bestätigen. Pläne verfallen nach 7 Tagen.

**Wo ist der alte XML-Upload?**

Nicht mehr nötig – die App liest die Workflow-Konfiguration direkt aus Jira.

**Wer sieht meine Notizen?**

Team-Notizen sind für alle Administratoren des Projekts im Workflow-Analyzer sichtbar.

**Was bedeutet „vorübergehend nicht verfügbar“ oder „Änderungen sind wegen Wartungsarbeiten pausiert“?**

SUPERPORT als App-Anbieter kann die App für Wartungsarbeiten oder bei einem Sicherheitsproblem pausieren: ganz („vorübergehend nicht verfügbar“) oder nur lesend (Sie können weiterhin alles ansehen, Änderungen sind pausiert). Ihre gespeicherten Daten bleiben erhalten. Den aktuellen Stand finden Sie auf unserer öffentlichen Statusseite: https://superapps.statuspage.io

**Was tun, wenn die App eine aktive Lizenz verlangt?**

Das Marketplace-Abonnement für diese Site ist nicht aktiv. Ein Jira-Administrator kann unter Apps › Apps verwalten eine kostenlose Testversion starten oder ein Abonnement abschließen. Ihre gespeicherten Pläne, Snapshots und Notizen bleiben erhalten.

---

# Guide: using the Workflow Analyzer safely

This guide walks you through everything from your first analysis to safe, AI-assisted workflow changes. Reading and analysing never changes anything in Jira – only an Autopilot plan that you explicitly apply does.

## ⚠ Golden rules for safe use

1. Analysing is always safe: Overview, Diagram, Transitions, Dependencies, Access, Flow, Health, Compare and Export only read data.
2. Jira is changed only when you confirm it: by an Autopilot plan after "Apply to Jira", or by repairing issue resolutions after "Yes, repair" – never automatically, never by the AI alone.
3. Read every plan before applying: operations (✓/✕), change preview, health score before/after and new findings.
4. Try bigger changes in a test space first (e.g. a copy of your project) before changing a productive workflow.
5. Watch the "shared workflow" warning: a shared workflow change affects every listed project.
6. Every apply stores a snapshot and a backup – know where "Roll back" is (Autopilot › plan).
7. Prefer project roles and groups over individual users in rules.
8. Exports contain names of users, groups and fields – share them only internally.

## 1. Getting started

The app reads your workflows live from Jira – no XML export and no field mapping needed anymore.

1. **Open the analyzer** – Project settings › Workflow Analyzer (project administrators). Jira administrators also find a site-wide analysis under Jira settings › Apps › Workflow Analyzer (site-wide).
2. **Choose your language** – Use DE / EN in the top right. Your choice is remembered for your user.
3. **Take the tour** – The "?" button starts a 1-minute guided tour. Shortcuts: "/" search, Alt+1…9 tabs, Esc closes panels.
4. **Select a workflow** – If the project uses several workflows, pick one in the "Workflow" selector – or keep "All workflows".

> 💡 Tip: Use the search field in the header to jump to any status, transition, group, field or app.

## 2. Understand your workflows

1. **Overview** – Health score, workflows, rules, dependencies and apps at a glance, a prioritised action plan and the health check per area.
2. **Diagram** – Click a status to highlight its paths, click a transition label for details. Overlays show issue load, persona access or the impact of a group/app.
3. **Transitions** – The familiar table: conditions, validators and post functions in plain language. Filter by app (JMWE, JSU, ScriptRunner …) or element, search, and add team notes.
4. **Transition details** – Click a transition name for an explanation of who can execute it, what is checked and what happens afterwards.

## 3. Check the impact before you change anything

1. **Dependencies** – Before deleting a group, uninstalling an app, renaming a field or deactivating a user: select it and see every affected transition. Red entries no longer exist on the site.
2. **Access simulator** – Answer "why can't this user move the ticket?": select the person's groups/roles and see allowed, blocked and data-dependent transitions. The path finder shows how an issue gets from A to B.
3. **Live flow** – Load live issue counts to find bottlenecks, stale work and statuses that are never used – important before removing a status.

> 💡 Tip: Use "Show in diagram" to see the impact of a group or app directly in the workflow graph.

## 4. Change workflows safely with the Autopilot

The Autopilot turns your request into a plan. Nothing changes until you apply the plan.

1. **1. Describe the change** – Write what you need in your own words, with exact names, e.g. "Add a status Escalated reachable from Review, only for the role Administrators, with a way back". Or use a template or "Auto-fix findings". Describing a change in your own words uses AI and is only available while the AI features are on (chapter 5); "Auto-fix findings" and the templates always work.
2. **2. Review the plan** – Check every operation (✓ = possible, ✕ = not possible and will be skipped), the preview of added/removed/changed elements, the health score before → after and any new findings.
3. **3. Check who is affected** – If the workflow is shared with other projects, the plan lists them. Apply only if the change is right for all of them – or ask your Jira admin to give the project its own workflow first.
4. **4. Apply** – "Apply to Jira" re-checks the plan against the latest version, lets Jira validate it, stores a snapshot and a backup, then updates the workflow. Company-managed workflows require Jira administrator rights.
5. **5. Verify** – Open the Diagram and Health tabs and try the changed transition with a test issue.
6. **6. Roll back if needed** – Autopilot › select the plan › "Roll back" restores the workflow exactly as before.

> ⚠ Removing a status moves its issues to the status you choose; rolling back restores the status but not the previous status of those issues. App rules (JMWE, ScriptRunner …) cannot be edited by the Autopilot – change them in the app itself.

## 5. Working with AI (Copilot & Rovo)

The AI features (AI chat, "Plan with AI", Bulk "Describe (AI)" and the Rovo agent) are **off by default**. Only Jira administrators (global permission "Administer Jira") can turn them on: Jira settings › Apps › Workflow Analyzer (site-wide) › card or tab "Settings" › **AI features** › "Turn on". This is also where they see this month's AI usage. While AI is off – or temporarily turned off by the app vendor – the app hides every AI feature completely: no AI chat, no "Plan with AI", no "Plan in Rovo chat", no "Fix with AI", no "Ask Rovo" buttons and no "Describe (AI)" template; this chapter and the AI hints in the tour and guide are not shown either, and the "AI assistant" tab is called "Explanations". Every non-AI feature (analysis, templates, "Auto-fix findings", plain-language explanations, reviewing, applying and rolling back plans) stays exactly as it is. Once a Jira administrator turns AI on, the features appear after reloading the page, or at the latest when you return to the open app.

1. **Ask questions** – AI assistant › "Ask your workflows" answers questions using the live analysis of this project. It runs on Atlassian (Forge LLMs) – your data stays in Atlassian Cloud.
2. **Rovo agent "Workflow Analyst"** – In Rovo chat you can ask for overviews, usages, health checks, access checks – and let it plan and apply changes. It always shows the plan and asks for confirmation before changing Jira.
3. **Write good requests** – Name the workflow, the exact status/transition names and the groups or roles. One change per request gives the clearest plans.

> ⚠ AI can misunderstand a request. Always read the operations list before applying a plan.

## 6. Fix findings and track the work

1. **Health check** – Every finding has a recommendation. Use "Show transition" to jump to the cause.
2. **Auto-fix** – Autopilot › "Auto-fix findings" creates a reviewable plan for findings that can be fixed automatically and lists the rest for manual follow-up.
3. **Jira tasks** – "Create Jira tasks" turns findings into tasks (labels workflow-health, superport-wfa) – duplicates are skipped.
4. **Issue resolutions** – A workflow fix only helps future transitions. Health check › "Issue resolutions" shows issues that are Done but Unresolved (reports count them as open) and open issues that still carry a resolution. "Review & repair" lists all of them with a suggestion per status (e.g. "Not approved" → Won’t Do); after you confirm, the Resolution field is set (Jira admins send no notification mails) or cleared through the workflow’s own transition into the current status – the status stays either way. Jira cannot take a set resolution back without moving the issue, so check the choices; clearing can be undone. Every run is in the repair history, and issues changed meanwhile are never overwritten.

## 7. Monitoring and change history

1. **Snapshots** – Changes › "Save snapshot" before larger changes, later "Compare with current" shows exactly what changed.
2. **Daily monitoring** – Enable it once per project: the app checks daily, stores a snapshot on every change and shows a banner on your next visit.

## 8. Document and share

1. **Export** – HTML (interactive single file, also for the Confluence HTML macro), PDF (print-ready), CSV (Excel) and JSON. Customer code and workflow label control the file name as before.
2. **Share responsibly** – Exports contain user, group and field names. Store them in internal spaces only.

## 9. Platform limits

The app runs on Atlassian Forge. Atlassian limits compute time, storage, invocations and API requests for all Forge apps (quotas and rate limits); the AI features are also subject to the limits of Forge LLMs and Rovo.

1. **Large workflows** – Analysing very large workflows or many projects can take longer.
2. **AI unavailable** – If AI is not available on your site right now or a quota is reached, the app says so. All non-AI features keep working.
3. **Monthly AI quota** – The limits are set by SUPERPORT, the app vendor, for all sites or for individual sites. By default each Jira site has an AI budget of €20, at most 1,000 AI requests and 2,000,000 tokens per calendar month (UTC), shared by the AI chat, "Plan with AI", Bulk "Describe (AI)" and plans made by the Rovo agent. The budget is included in your subscription; it costs you nothing extra. When any of them is used up, the app says "The monthly AI quota is used up. It is available again from the 1st of next month." Jira administrators see the usage and the limits that apply to their site next to the "AI features" switch. If SUPERPORT temporarily turns the AI off, the app says "AI features are temporarily turned off by the app vendor. Please try again later."; your setting is kept.
4. **App status and maintenance** – If SUPERPORT has to pause the app for maintenance or a security issue, it shows "temporarily unavailable" or a notice that changes are paused (viewing keeps working). The current status is on the status page https://superapps.statuspage.io.
5. **Interrupted changes** – If a limit is reached during a change, the app shows an error. Check the change history to see what was applied and repeat the rest a little later.

## Frequently asked questions

**Can the analysis break anything?**

No. All tabs except the Autopilot "Apply" and "Roll back" buttons, "Create Jira tasks", "Enable monitoring" and the issue resolution repair only read data.

**Why do I see "depends" in the access simulator?**

The result depends on data of the concrete issue (field values, history) or on app conditions that are only evaluated at runtime.

**Why can't I apply a plan?**

Company-managed workflows can only be changed by Jira administrators. For shared workflows, confirm the warning first. Plans expire after 7 days.

**Where is the old XML upload?**

Not needed anymore – the app reads the workflow configuration directly from Jira.

**Who sees my notes?**

Team notes are visible to all administrators of the project in the Workflow Analyzer.

**What does "temporarily unavailable" or "Changes are paused for maintenance" mean?**

SUPERPORT, the app vendor, can pause the app for maintenance or a security issue: completely ("temporarily unavailable") or read-only (you can still view everything, changes are paused). Nothing you saved is lost. The current status is on our public status page: https://superapps.statuspage.io

**What if the app says it needs an active licence?**

The Marketplace subscription for this site is not active. A Jira administrator can start a free trial or subscribe under Apps › Manage your apps. Your saved plans, snapshots and notes are kept.

---
