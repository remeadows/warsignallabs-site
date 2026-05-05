# HANDOFF.md — warsignallabs.net (root)

**Last updated:** 2026-05-05 by Claude (Cowork)
**Previous update:** 2026-05-02 (archived inline below)
**Scope:** entire `warsignallabs.net` property. For portal-only handoff, see `portal-app/handoff.yaml`.

> **This file is the single source of truth for current-state.** Update at the end of every working session. Stale handoffs cause agent drift.

---

## Session Summary — 2026-05-05

**Shipped: site-wide content & tone overhaul (PR #9, merged).** The previous cyberpunk/operator-grade voice failed the mom-test for non-technical readers — exactly the audience the practice now needs to win (non-profit boards, nationwide commercial firms). Rewrote all 10 marketing pages and the global stylesheet in a measured executive register; retired the cyberpunk visual identity.

What landed:

- **Visual identity replaced:** Orbitron / Share Tech Mono / Rajdhani → IBM Plex Sans / Serif / Mono. Neon cyan/magenta/amber/green → dark navy ground (`#0E1726`) with one muted steel-blue accent (`#6F8FB8`) and burnished gold (`#C9A557`) for primary CTAs only. Dropped clip-path notched cards, blinking cursor, scanline overlay, animated grid background, fake-CLI demo blocks, status-dot footer.
- **Tone replaced:** retired all `// OPERATOR PROFILE`, `ESTABLISH LINK`, `FLAGSHIP PRODUCT`, `OPERATIONAL DOCTRINE`, `CAPABILITY MATRIX`, `SVC_NNN`, `[ MENU ]`, `ALL SYSTEMS OPERATIONAL`, `// FOUNDER — WARSIGNALLABS`. Cyberpunk-residue grep returns zero hits across the marketing site (Studio is the one defensible exception — it's an honest synthwave personal music project).
- **GridWatch Enterprise reframed** from "flagship product" to honest concluded capability proof. Removed roadmap, "Request Demo" CTA, "Target Users" section.
- **GW-OS promoted to flagship technical work** — 14-agent intelligence pipeline on Pi + Ollama. Three stages: collection (cybersecurity, cyber warnings, world news, economy/financials, AI news) → quality control → publication (drafts, formatting, push to WSL portal).
- **Agent-communication research** is now the headline of `labs.html`, with the additive-decomposition equation as centerpiece: `f_final(x) ≈ f_base(x) + Δf_protocol(x) + Δf_LoRA(x)`. Plain-English thesis: a repeatable local-AI research pipeline that measures base-model behavior, then adds protocol/prompt corrections and LoRA/QLoRA corrections, and measures again — the same scoring, every time.
- **Russ headshot** (`russ-headshot.webp`) replaces the Rusty cartoon on home About.
- **Client Portal** added back to primary nav as a plain-text item across all 10 pages (the prior `nav-portal` accent button was retired in the rewrite).
- **New nav order** (consistent across all 10 pages): Services · Work · Research · Studio · About · Contact · Client Portal.

Net diff (PR #9): 11 HTML pages + global stylesheet + 1 new asset; ~2,177 insertions, ~3,314 deletions. Site is leaner because per-page inline cyberpunk CSS duplication collapsed into the global stylesheet.

**Doc updates this session (PR follow-up):**

- `CONTEXT.md` — Brand & Voice section rewritten; audience priority shifted; "what is real" updated.
- `ARCHITECTURE.md` — Page inventory updated (10 pages, new nav labels, file paths preserved); stack table reflects IBM Plex; AR-04 (inline CSS) downgraded to P3; AR-11 added (headshot AI artifact).
- `BACKLOG.md` — P1-1, P2-3, P2-4 closed/advanced; P1-10 reframed; new "Shipped 2026-05-05" section.
- `AGENTS.md` — File ownership table adds `russ-headshot.webp`; task routing rule for home-page copy now references the Brand & Voice rules.
- `DECISIONS/0003-content-tone-overhaul.md` — **new ADR** documenting the rationale and decisions.
- `.gitignore` — `.wrangler/` now ignored (Cloudflare CLI local cache).

**Known follow-ups (not in this PR):**

- Headshot regeneration before any larger crop use — wall behind subject has a faint AI artifact below the "Observe / Analyze / Respond" tagline (AR-11).
- Portal theme (`portal-app/src/themes/base.css`) still uses the prior cyberpunk palette. Decide whether to align portal to the new identity or accept divergence (P1-10).
- `WEBSITE_OVERHAUL_PLAN.md` Phase 0 (Cloudflare zone migration) still not started — same blocker as 2026-05-02.

---

## Active Initiatives

### 1. Content & Tone Overhaul — SHIPPED 2026-05-05
- **Status:** Merged (PR #9). Live on `main`.
- **Follow-up:** AR-11 headshot regeneration; P1-10 portal-theme reconciliation.
- **ADR:** `DECISIONS/0003-content-tone-overhaul.md`

### 2. Clerk Production Migration (portal)
- **Phase:** 1 of 6 — blocked on Russ
- **Detail:** `portal-app/handoff.yaml`
- **Pending input:** `pk_live_` publishable key, custom-domain CNAME records from Clerk dashboard
- **Why blocking matters:** Chris DePalma (cdepalma) cannot log into the portal because the dev Clerk instance forces third-party cookies that his browser blocks. Resolution requires production Clerk + `clerk.warsignallabs.net` custom subdomain.

### 3. Cloudflare Zone Activation (Phase 0)
- **Status:** Not started — requires Russ to switch nameservers at Squarespace
- **Linear:** [REM-652](https://linear.app/remeadows/issue/REM-652)
- **Unlocks:** P0-3 (security headers via Transform Rules), P1-7 (CF Web Analytics), P2-6 (cache rules), the entire Phase 4 of `WEBSITE_OVERHAUL_PLAN.md`
- **Risk:** every day this stays on GitHub Pages alone is another day the marketing site contradicts the security posture being sold

---

## Current State — by surface

### Marketing site (warsignallabs.net)
- Live, on GitHub Pages, on the new visual identity (post-PR-#9)
- 10 pages: home, services, deployed-systems (Work hub), gridwatch-enterprise (case study), labs (Research), studio (music), warsignal-vision (About), support, privacy, 404
- Phase 1 (critical fixes) and Phase 2 (SEO/meta) complete
- Phase 3 (perf — CSS extraction) **substantially advanced** by the 2026-05-05 overhaul; per-page `<style>` blocks reduced; remaining inline styles are page-specific layouts. Lazy-load and preload still pending audit.
- Phase 4 (security headers via Cloudflare) **blocked by Phase 0**
- Phase 5 (content) **substantially complete** — About page (`warsignal-vision.html`) now substantive; vision expansion done; 404 cleaned up. App Store link still pending GridWatchMatch Build 3.

### Portal (portal.warsignallabs.net)
- Live, v0.2.2 with operational dashboard + GW-OS Briefs
- Most recent commit: `122ac84 feat(portal): enable GW-OS Briefs dashboard with list + detail view`
- See `portal-app/handoff.yaml` for portal-internal state

### API (api.warsignallabs.net)
- Live Worker (`wsl-portal-api`), last modified 2026-04-03
- Worker secrets set: `CLERK_SECRET_KEY`, `RESEND_API_KEY`
- Will need redeploy + secret rotation during P0-1 (Clerk prod migration)

---

## Working Tree — uncommitted changes

After PR #9 merged (content/tone overhaul) the doc set was still uncommitted from the prior 2026-05-02 session. This session's PR (`wsl/docs-post-overhaul`) commits the doc set — updated to reflect the post-overhaul state — plus the new ADR-0003.

Files committed by this session's PR:
```
?? AGENTS.md          (now tracked)
?? ARCHITECTURE.md    (now tracked)
?? BACKLOG.md         (now tracked)
?? CONTEXT.md         (now tracked)
?? DECISIONS/0001-baseline-architecture.md  (now tracked)
?? DECISIONS/0002-security-headers-gap.md   (now tracked)
?? DECISIONS/0003-content-tone-overhaul.md  (new this session)
M  HANDOFF.md         (this file — updated with 2026-05-05 session)
M  .gitignore         (adds .wrangler/)
```

Files **not** committed by this session (left for Russ):
```
M  .DS_Store          (cosmetic, gitignored anyway)
M  _headers           (Russ's pre-existing edit — not touched by docs PR)
?? .wrangler/         (Cloudflare CLI cache — now in .gitignore)
?? portal-app/handoff.yaml   (portal-internal; track in portal-app PR)
?? portal-app/memory.yaml    (portal-internal; track in portal-app PR)
```

---

## Pending / Blocked

| Item | Blocker | Owner | Linear |
|---|---|---|---|
| Clerk prod migration Phase 2-6 | `pk_live_` + CNAME records from Russ | Russ + Claude | (pending ticket) |
| Cloudflare zone activation | Russ at domains.squarespace.com | Russ | [REM-652](https://linear.app/remeadows/issue/REM-652) |
| Security headers (P0-3) | Phase 0 above | Claude | [REM-656](https://linear.app/remeadows/issue/REM-656) |
| Phase 3 perf work (P1-1 through P1-4) | None — can start anytime | Claude | [REM-655](https://linear.app/remeadows/issue/REM-655) and children |
| `_headers` warning banner (P0-4) | None | Claude | new |
| Theme token consolidation (P1-10) | Mild — needs scope decision | Claude | new |

---

## Recent Commit History (root repo, last 10)

```
3ff6746 Merge pull request #9 from remeadows/wsl/content-tone-overhaul
35ca17d feat(site): content + visual overhaul for non-technical-audience credibility
a45aea2 Merge pull request #8 from remeadows/wsl/canonical-root-redirect
f2cd0ea fix(css): hero padding-top default + scroll-padding-top for fixed nav clearance
aa1fcbf fix(home): canonical root redirect for /index.html -> / (CDN cache parity)
dcdbb72 Merge pull request #7 from remeadows/wsl/war-doctrine-studio-x
8d57c87 feat(studio): wire WAR SIGNAL artist embeds (Spotify + Apple Music)
2eac034 feat(studio): add /studio.html music page + site-wide nav integration
2524e5e feat(site): add X / Twitter integration site-wide
0db1765 feat(home): add W.A.R. Doctrine section (Watch / Analyze / React)
```

The 2026-05-05 overhaul is the largest single content commit in the repo's history. The "W.A.R. Doctrine" section from `0db1765` is the one piece that was conceptually preserved but rewrapped — it now reads as the plain-language "Observe / Analyze / Respond" loop on the home page, without the giant decorative letters or operator-grade framing.

---

## Resume Instructions (next session)

1. Read this file. Read `CONTEXT.md` (Brand & Voice rules are now load-bearing — measured executive register, no cyberpunk/mil-com framing). Read `BACKLOG.md`. Read `git status`.
2. If Russ has provided `pk_live_` + CNAMEs → resume Clerk migration at `portal-app/handoff.yaml` Phase 2.
3. If not → pick from P1 backlog. P1-10 (portal theme reconciliation against the new marketing identity) is the highest-leverage cross-cutting work today.
4. P0-4 (`_headers` warning banner) is a 5-minute fix and should land regardless.
5. AR-11 (headshot regeneration) is owned by Russ; flag it before any larger-crop use of the photo.

---

## Archive — Previous HANDOFF (2026-05-02)

> Preserved verbatim from prior session. Status as of 2026-05-05 noted in `[brackets]`.

```
Bootstrapped the canonical doc set for the root repo:

- Wrote: CONTEXT.md, ARCHITECTURE.md, AGENTS.md, BACKLOG.md
  [STATUS 2026-05-05: now tracked + updated to reflect post-overhaul state]
- Wrote: DECISIONS/0001-baseline-architecture.md, DECISIONS/0002-security-headers-gap.md
  [STATUS 2026-05-05: now tracked; ADR-0003 added for content/tone overhaul]
- Replaced previous HANDOFF.md (March 2026) — archived inline below
- Identified P0 security gap — `_headers` file is dead on GitHub Pages
  [STATUS 2026-05-05: STILL UNRESOLVED — same blocker (Phase 0 not started)]

No code changes to marketing pages this session — docs only.
[STATUS 2026-05-05: code changes shipped 2026-05-05 in PR #9 — content/tone overhaul]
```

---

## Archive — Previous HANDOFF (2026-03-24)

> Preserved verbatim from prior session for traceability. Status as of 2026-05-02 noted in `[brackets]`.

```
Two sessions on 2026-03-24. Completed Phase 1 (Critical Fixes) and Phase 2
(SEO + Meta Layer) of the website overhaul. Updated all Linear tickets.
Validated Cloudflare account for Phase 0.

Phase 1 — Critical Fixes (REM-653) — CLOSED
  REM-664 email fix          [confirmed live: remeadows@warsignallabs.net]
  REM-667 title fix          [confirmed live]
  REM-668 stale files purge  [confirmed clean]
  REM-665 footer anchors     [confirmed]
  REM-666 footer nav std     [confirmed]

Phase 2 — SEO + Meta (REM-654) — 6/7 done
  REM-669..672 meta/OG/Twitter/canonical    [confirmed live on all pages]
  REM-673 favicon assets       [now resolved — assets in repo as of 2026-03-24]
  REM-674 robots.txt + sitemap [live]
  REM-675 JSON-LD              [live on home, services, gridwatch]

Phase 0 — Cloudflare Migration (REM-652)
  Account 210e77c9da5741b3aa1b6199a082d70b validated
  Zone not yet created
  Cloudflare MCP only exposes Workers/D1/KV/R2 — no zone management
  Nameserver switch requires Russ at domains.squarespace.com
  [STATUS 2026-05-02: STILL NOT STARTED]

Path discrepancy flagged: about-me.md references wrong path
  [STATUS 2026-05-02: STILL UNRESOLVED — filed as P1-5]
```

---

*Update this file at the end of every session. If you don't, the next agent (or you, in 3 weeks) will repeat work that's already done.*
