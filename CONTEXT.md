# CONTEXT.md — warsignallabs.net (root property)

**Scope:** entire `warsignallabs.net` web property — marketing site + portal subapp + API worker.
**Owner:** Russ Meadows (`remeadows@warsignallabs.net`)
**Linear workspace:** [remeadows](https://linear.app/remeadows)
**Last updated:** 2026-05-05 by Claude (Cowork)

> This is the **root context document** for any agent (Claude, Codex, Gemini, human) entering the repo. Read this before touching any file. Subapp-specific context lives in `portal-app/CONTEXT.md`.

---

## What This Property Is

`warsignallabs.net` is the public-facing web presence and client portal for WarSignalLabs — Russ Meadows' independent cybersecurity / network engineering practice (sole proprietor, WarSignalLabs LLC) operating alongside his W-2 ISSE role at Toyon Research.

Three logical surfaces under one zone:

| Surface | URL | Purpose | Technology |
|---|---|---|---|
| Marketing | `warsignallabs.net` | Capabilities, GridWatch product, deployed systems, vision, contact | Static HTML/CSS/JS on GitHub Pages |
| Portal | `portal.warsignallabs.net` | Authenticated client workspaces — file exchange, audit trail, RBAC | React 19 + Vite on Cloudflare Pages |
| Portal API | `api.warsignallabs.net` | JSON API for portal | Cloudflare Worker + D1 + R2 |

The marketing site is the **front door**. The portal is **revenue-bearing infrastructure** — actively used by Blueprint Advisory and internal WSL operations.

---

## Audience

Audience priority shifted in the 2026-05-05 content/tone overhaul. The #1 reader is now non-technical decision-makers — non-profit boards and nationwide commercial firms — who must trust the practice within 30 seconds without parsing acronyms. DoD/enterprise readers still respect the substance, but they are no longer the gating audience. (See `DECISIONS/0003-content-tone-overhaul.md`.)

| Audience | Surface | Priority | What they need from the property |
|---|---|---|---|
| Non-profit boards (kids' programs, etc.) | Marketing | **#1** | Plain-English credibility — what is this practice, what has it shipped, can I trust the operator |
| Nationwide commercial firms | Marketing | **#1** | Same as above + signal of engineering depth without jargon overload |
| DoD / federal contracting POCs | Marketing | #2 | Substance: STIG/RMF/ATO competence, clearance posture, deployed proof — surfaced below the fold |
| Existing clients (Blueprint Advisory, etc.) | Portal | — | Secure file exchange + visible audit trail |
| Recruiters / collaborators | Marketing | — | LinkedIn parity, GitHub link, contact |
| Russ (operator) | Both | — | Demo-ready surface for sales calls |

---

## Brand & Voice

**Aesthetic** — measured, conservative, intentional. Deloitte / McKinsey Digital / Booz Allen tier. Dark navy ground (`#0E1726`), single muted steel-blue accent (`#6F8FB8`), burnished gold (`#C9A557`) for primary CTAs only. **No neon.** Hairline rules instead of glowing dividers. Flat or subtly rounded rectangles instead of clip-path notches.

**Typography** — IBM Plex Sans (body), IBM Plex Serif (display, headings), IBM Plex Mono (code blocks and technical specs only). All Google-Fonts-hosted, `display=swap`.

**Tone** — measured, plain, declarative. Active voice. Specific nouns. Acronyms defined first use, used sparingly. The reader is an intelligent decision-maker who is *not* in security.

**Yes:**
- "WarSignalLabs is a security engineering practice."
- "Built and shipped a survey platform for an executive coaching firm. Production today."
- "GW-OS is a small fleet of Raspberry Pi devices running local AI models."

**No** (these are the kill-list — grep returns zero across the marketing site):
- "ESTABLISH LINK," "OPERATOR PROFILE," "OPERATIONAL DOCTRINE," "CAPABILITY MATRIX," "FLAGSHIP PRODUCT"
- `// FOUNDER — WARSIGNALLABS`, `[ MENU ]`, `SVC_001`, `// EMAIL`, fake-CLI demo blocks
- Blinking cursor, ALL-CAPS `//`-prefixed kickers, color-split WAR/SIGNAL/LABS title
- "ALL SYSTEMS OPERATIONAL" status footer
- The word **cyberpunk** anywhere on the marketing pages (Studio is the one defensible exception — it's an honest-synthwave personal music project)
- Mil-com framing: "operator," "deploy" (when "ship" works), "establish"
- Hyperbole: "engineered from the ground up," "purpose-built," "tools defenders need"

**Hard constraints:**
- Acronyms defined on first use; on non-DoD pages most stay below the fold
- Never soften technical claims that are factual (DoD enterprise environments, STIG compliance, ATO experience)
- Studio page (`studio.html`) is the single exception that may retain stylistic personality — synthwave is genuinely synthwave there
- Pass the **mom-test**: a non-technical board chair must be able to describe in plain English what WarSignalLabs does after 2 minutes on the site

---

## Current Initiatives (as of 2026-05-05)

| # | Initiative | Surface | Status | Owner | Linear |
|---|---|---|---|---|---|
| 1 | Content & tone overhaul (cyberpunk → executive register) | Marketing | **Shipped 2026-05-05** (PR #9) | Claude | new |
| 2 | Clerk dev → production migration | Portal | In progress, blocked on user input | Shared (Russ + Claude) | Pending ticket |
| 3 | Cloudflare zone migration (Phase 0) | DNS / both surfaces | Not started — manual user step required | Russ | [REM-652](https://linear.app/remeadows/issue/REM-652) |
| 4 | Security headers via Cloudflare Transform Rules | Marketing | **Blocked by #3** | Claude | [REM-656](https://linear.app/remeadows/issue/REM-656) |
| 5 | CSS extraction + perf pass | Marketing | Partially advanced by #1 (global tokens consolidated; per-page `<style>` blocks remain) | Claude | [REM-655](https://linear.app/remeadows/issue/REM-655) |

See `HANDOFF.md` for current-state detail and `BACKLOG.md` for prioritized work.

---

## What Is Real Right Now (live, in production)

- 10 static pages on `warsignallabs.net`: home, services, deployed-systems (now case-study hub: Blueprint Advisory + GW-OS + GridWatch Enterprise), labs (Research + portfolio), gridwatch-enterprise (case study), studio (WAR SIGNAL music project), warsignal-vision (About), support, privacy, 404
- New visual identity (post-2026-05-05 overhaul): IBM Plex stack, dark navy ground, muted steel-blue + gold accents — see Brand & Voice above
- Russ professional headshot (`russ-headshot.webp`) replaces the Rusty cartoon on the home About section
- Primary nav (consistent across all 10 pages): Services · Work · Research · Studio · About · Contact · Client Portal
- Portal v0.2.0+ with folder browser, RBAC, file versioning, Resend email notifications, GW-OS Briefs dashboard
- 4 user accounts in D1, 3 workspaces (WarSignalLabs internal, Lunch out of Landfills, Blueprint Advisory)
- Email notifications via Resend (`portal@warsignallabs.net`)
- Worker secrets set: `CLERK_SECRET_KEY`, `RESEND_API_KEY`

## What Is Not Real Yet

- DNS not yet on Cloudflare — still on Squarespace registrar/DNS
- HTTP response headers (HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy, response-CSP, frame-ancestors) **not delivered** on the marketing site — see `DECISIONS/0002-security-headers-gap.md`
- No analytics on marketing site
- No App Store link for GridWatchMatch (build not shipped)
- Headshot has a faint AI-generated artifact below the wall tagline — invisible at the 120px circular About crop, visible at any larger crop. Re-generate before LinkedIn-banner / full-bleed / OG-share use.
- Lunch Out of Landfills is intentionally absent from the public marketing site until the work is ready to surface

---

## Repo Layout (one-screen orientation)

```
warsignallabs-site/
├── *.html                 # Static marketing pages (GitHub Pages, 10 files)
├── styles.css             # Global design tokens + base components (post-2026-05-05 overhaul)
├── site.js                # Nav toggle + IntersectionObserver fade-ins
├── _headers               # Cloudflare Pages / Netlify format — NOT honored by GitHub Pages (dead file today)
├── robots.txt, sitemap.xml, CNAME, favicon-*
├── russ-headshot.webp     # Professional headshot (used on home About)
├── WarSignal*.webp, Rusty.webp/.png  # Other brand assets
├── CONTEXT.md             # ← you are here
├── ARCHITECTURE.md        # System diagram + data flow
├── AGENTS.md              # Agent responsibility matrix
├── HANDOFF.md             # Current-state / in-flight (UPDATE EVERY SESSION)
├── BACKLOG.md             # Prioritized P0/P1/P2/P3 work
├── SECURITY.md            # Public security policy + reporting
├── WEBSITE_OVERHAUL_PLAN.md  # Original 6-phase infra plan (March 2026 — superseded for content)
├── DECISIONS/             # ADRs (0001 baseline, 0002 headers, 0003 content/tone overhaul)
├── portal/                # Portal architecture (machine-readable)
│   └── architecture.yaml
└── portal-app/            # The actual portal subapp (React + Worker)
    ├── CONTEXT.md         # Portal-specific context (read this for portal work)
    ├── AGENTS.md          # Portal-specific agent rules
    ├── handoff.yaml       # Portal current-state (machine-readable)
    ├── memory.yaml        # Long-lived portal context
    ├── src/, worker/, public/, dist/
    └── ...
```

---

## How Agents Should Work Here

1. **Always read `HANDOFF.md` first** — current sprint state, blockers, last decision.
2. **For portal work**, descend into `portal-app/` and read `CONTEXT.md`, `AGENTS.md`, `handoff.yaml`.
3. **For marketing work**, stay at root.
4. **Never conflate the two** — the marketing site is GitHub Pages (no headers, no server logic). The portal is Cloudflare Pages + Worker. Different deploy paths, different security postures.
5. **Update `HANDOFF.md` at the end of every session.** Stale handoffs are the #1 cause of agent drift.
6. **Linear is the source of truth for tickets.** Reference `REM-XXX` IDs in commits.

---

## Cross-References

- `ARCHITECTURE.md` — the actual system, end-to-end
- `AGENTS.md` — who does what (Claude, Codex, Russ)
- `HANDOFF.md` — what's in flight today
- `BACKLOG.md` — what's next
- `SECURITY.md` — public-facing security policy
- `DECISIONS/0001-baseline-architecture.md` — why the architecture is what it is
- `DECISIONS/0002-security-headers-gap.md` — the GitHub-Pages header limitation and the path off it
- `DECISIONS/0003-content-tone-overhaul.md` — why the cyberpunk identity was retired in favor of an executive register
- `portal-app/CONTEXT.md` — portal subapp truth source
- `portal/architecture.yaml` — portal architecture (machine-readable, slightly older snapshot)

---

*If you change anything material in the repo, update this file too. Stale context is technical debt that compounds.*
