# BACKLOG.md — warsignallabs.net

**Last updated:** 2026-05-05

Prioritized work across the entire `warsignallabs.net` property. **P0 = ship now or risk something breaking / credibility loss. P1 = next sprint. P2 = next month. P3 = nice-to-have.**

For portal-internal backlog, see Linear [Client Portal project](https://linear.app/remeadows/project/client-portal-portalwarsignallabsnet-01fa033a) and `portal-app/handoff.yaml`. This file focuses on the marketing site + cross-cutting concerns.

---

## P0 — Ship now

| # | Task | Surface | Linear | Effort | Blocker |
|---|---|---|---|---|---|
| P0-1 | Complete Clerk dev → prod migration (in flight per `portal-app/handoff.yaml`) | Portal | Pending ticket | M | Russ to provide pk_live + CNAMEs |
| P0-2 | Cloudflare zone activation for `warsignallabs.net` (Phase 0) | DNS | [REM-652](https://linear.app/remeadows/issue/REM-652) | S (mechanical), but requires user nameserver switch at Squarespace | Russ |
| P0-3 | After P0-2: deliver real response headers (HSTS, XFO, XCTO, Permissions-Policy, response-CSP w/ frame-ancestors) via Cloudflare Transform Rules | Marketing | [REM-656](https://linear.app/remeadows/issue/REM-656) → [REM-681..684](https://linear.app/remeadows/issue/REM-681) | S | P0-2 |
| P0-4 | Add a comment banner to `_headers` warning that GitHub Pages does NOT honor it (so future agents don't assume it's live) | Marketing | new | XS | none |

**Why P0:**
- Selling cybersecurity competence with missing baseline web security headers is a credibility gap. The window between "Russ trusts the site to one client" and "a sharp prospect runs `curl -I` on it" is small.
- Clerk migration is unblocking a paying-relationship-adjacent user (Chris DePalma). Until it ships, any "show your portal in a sales call" carries the risk of his blank-screen experience showing up.

---

## P1 — Next sprint

| # | Task | Surface | Linear | Effort |
|---|---|---|---|---|
| ~~P1-1~~ | ~~Extract per-page inline `<style>` blocks~~ — substantially advanced by the 2026-05-05 overhaul. Global tokens + base components now in `styles.css`; per-page blocks contain only page-specific layouts. **Downgraded to P3 / acceptable as-is.** | Marketing | [REM-676](https://linear.app/remeadows/issue/REM-676) | — |
| P1-2 | Audit every `<img>` in marketing pages — confirm `width`, `height`, and `loading="lazy"` (below-fold) are set. Fix CLS on slow first paint. | Marketing | [REM-677](https://linear.app/remeadows/issue/REM-677), [REM-678](https://linear.app/remeadows/issue/REM-678) | S |
| P1-3 | Add `font-display: swap` to Google Fonts URLs (already set on home `display=swap` query — verify on every page) | Marketing | [REM-679](https://linear.app/remeadows/issue/REM-679) | XS |
| P1-4 | Verify hero `<link rel="preload" as="image">` is present on every page that uses a hero image | Marketing | [REM-680](https://linear.app/remeadows/issue/REM-680) | XS |
| P1-5 | Reconcile path discrepancy noted in old HANDOFF: `about-me.md` references `/Dev/1 - WarSignalLabs/4 - Games/warsignallabs-site` but actual path is `/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site` | Cross-cutting | new | XS |
| P1-6 | Add CI: GitHub Action with htmlhint + lychee link check + lighthouse-ci on every push to `main` | Marketing | new | M |
| P1-7 | Add Cloudflare Web Analytics snippet (after P0-2) — privacy-friendly, no JS tracker on user; just one beacon | Marketing | [REM-683](https://linear.app/remeadows/issue/REM-683) | XS |
| P1-8 | Decide: keep marketing on GitHub Pages (proxied through Cloudflare) vs. migrate to Cloudflare Pages. Open ADR. | Architecture | new | S (decision), M (migration if chosen) |
| P1-9 | Update / archive `WEBSITE_OVERHAUL_PLAN.md` — it's 6 weeks stale and partially superseded | Docs | new | XS |
| P1-10 | Reconcile design tokens between marketing `styles.css` (post-overhaul: IBM Plex + dark navy + steel-blue + gold) and `portal-app/src/themes/base.css` (still on the prior cyberpunk palette). Decide: align portal to the new identity, or accept divergence. | Cross-cutting | new | M |

---

## P2 — Next month

| # | Task | Surface | Linear | Effort |
|---|---|---|---|---|
| P2-1 | Generate `sitemap.xml` from filesystem in CI (kill the hand-maintained drift risk) | Marketing | new | S |
| P2-2 | Add `<link rel="alternate" hreflang="x-default">` if/when international markets become real (defer if not) | Marketing | new | — (defer) |
| ~~P2-3~~ | ~~Build a real About page~~ — **done 2026-05-05**: `warsignal-vision.html` reframed as the About page with bio, two engines, principles, methodology, philosophy. | Marketing | [REM-688](https://linear.app/remeadows/issue/REM-688) | — |
| ~~P2-4~~ | ~~Expand `warsignal-vision.html`~~ — **done 2026-05-05**: full content rewrite with four operating principles, five-step methodology, defense-in-depth philosophy block, About-Russ section. | Marketing | [REM-686](https://linear.app/remeadows/issue/REM-686) | — |
| P2-5 | Add App Store badge + link on `labs.html` once GridWatchMatch Build 3 ships | Marketing | [REM-687](https://linear.app/remeadows/issue/REM-687) | XS |
| P2-6 | Cloudflare caching rules — set explicit Cache-Control on static `.webp`, `.css`, `.js`, fonts | Marketing | [REM-684](https://linear.app/remeadows/issue/REM-684) | S |
| P2-7 | Add observability: Logpush from Worker to a log destination (BetterStack, Loki, or CF Workers Analytics Engine) | Portal | new | M |
| P2-8 | Email throttling / rate limit on Resend sends — current fire-and-forget could fan out badly during a workspace event storm | Portal | new | S |
| P2-9 | Open-source-ready hardening of the marketing repo (LICENSE, CONTRIBUTING, basic CONTRIBUTING.md, issue templates) — only if Russ wants to make it public | Marketing | new | S |

---

## P3 — Nice to have

| # | Task | Surface |
|---|---|---|
| P3-1 | Per-PR Cloudflare Pages preview deploys for marketing (after P1-8 migration if chosen) |
| P3-2 | 3D / interactive visual on the home page — terminal scroll, network graph, etc. — only if it doesn't slow LCP |
| P3-3 | RSS / `/feed.xml` if a writing surface ever ships |
| P3-4 | i18n scaffolding (only if a non-English customer materializes) |
| P3-5 | Replace Google Fonts with self-hosted subset (privacy + LCP) |
| P3-6 | Dark/light theme toggle — currently dark-only by design; consider only if it serves a real audience |
| P3-7 | Service worker for marketing pages (offline-capable, faster repeat visits) |

---

## Discovered while building this doc set (2026-05-02)

- AR-01 / AR-03: `_headers` file in repo is misleading. Filed as P0-4.
- AR-04: ~530 lines of inline CSS in `index.html`. Filed as P1-1.
- AR-06: No CI on marketing repo. Filed as P1-6.
- AR-09: Hand-maintained `sitemap.xml`. Filed as P2-1.
- Stale `WEBSITE_OVERHAUL_PLAN.md`. Filed as P1-9.

## Shipped 2026-05-05 (content & tone overhaul, PR #9)

- Site-wide rewrite: cyberpunk identity → measured executive register. Audience priority shifted to non-profit boards + nationwide commercial firms as the gating reader.
- Visual identity: Orbitron / Share Tech Mono / Rajdhani → IBM Plex Sans/Serif/Mono. Neon palette → dark navy + steel-blue + gold.
- GridWatch Enterprise reframed from "flagship product" to honest concluded capability proof.
- GW-OS promoted to flagship technical work — 14-agent intelligence pipeline (Pi + Ollama).
- Agent-communication research surfaced as headline of `labs.html` with the additive-decomposition equation `f_final(x) ≈ f_base(x) + Δf_protocol(x) + Δf_LoRA(x)`.
- Russ headshot (`russ-headshot.webp`) replaces the Rusty cartoon.
- "Client Portal" added back to primary nav as plain-text link (the prior `nav-portal` accent button was retired).
- New ADR: `DECISIONS/0003-content-tone-overhaul.md`.
- Closes/advances: P1-1 (CSS, downgraded), P2-3 (About page), P2-4 (Vision expansion).

## New issues discovered during the overhaul

| # | Item | Severity | Notes |
|---|---|---|---|
| AR-11 | Russ headshot has faint AI-generated artifact below the wall tagline | P3 | Invisible at 120px circular About crop; visible at larger crops. Re-generate or shoot a clean version before LinkedIn / OG / full-bleed use. |
| AR-12 | Audience-segment landing pages may be needed | P3 | Non-profit-board readers and DoD-procurement readers may want different first-screen framing. Single home page serves both today via measured tone. Revisit if either audience converts poorly. |

---

## Definition of Done (for any item above)

1. Linear ticket exists and references this backlog item.
2. Code change committed with `REM-XXX` reference.
3. Pushed to `main` and verified live.
4. `HANDOFF.md` updated.
5. If architectural: ADR added under `DECISIONS/`.
6. If P0/P1: Russ has eyeballed the live site post-deploy.

---

*Maintained by Claude (Cowork). Re-prioritize at the start of every sprint.*
