# Marketplace package: Workflow Analyzer & Optimizer for Jira

Everything needed to list the app. Start with [LISTING.md](LISTING.md).

| File | Use |
|---|---|
| [LISTING.md](LISTING.md) | Listing texts, highlights, gallery captions, pricing proposal, scope justification, portal checklist |
| [DATA_SECURITY_PRIVACY.md](DATA_SECURITY_PRIVACY.md) | Answers for the *Privacy & Security* tab |
| `app-logo-144.png`, `app-logo-512.png` | App logo |
| `banner-1120x548.png` | Listing banner (UPM) |
| `hero-960x600.png` | Hero image |
| `screenshots/*.png` | 12 screenshots, 1840×900 (3 highlights + gallery) |

Screenshots, hero and banner are generated: start the click-dummy (`npm run dev:ui`) and run
`node scripts/capture-marketplace.mjs` (or name single shots, e.g. `overview hero`). It drives local headless Chrome with the
English demo data (`#demo=en`).

Search for **⟦CONFIRM⟧** (decisions) and **⟦OPEN⟧** (gaps) before submitting.
