# ARCHITECTURE.md — warsignallabs.net

**Scope:** entire `warsignallabs.net` zone — marketing site, portal, API.
**Last updated:** 2026-05-05

This document describes how `warsignallabs.net` is built and deployed today, plus the target state and open architectural risks. For the *why* of any decision, see the ADRs under `DECISIONS/`.

---

## 1. Topology (current state)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Squarespace Domains  (registrar + AUTHORITATIVE DNS — current)      │
│  Zone: warsignallabs.net                                             │
└─────────────────────────────────────┬────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │                             │                              │
        ▼                             ▼                              ▼
   warsignallabs.net           portal.warsignallabs.net      api.warsignallabs.net
        │                             │                              │
   GitHub Pages              Cloudflare Pages                 Cloudflare Worker
   (remeadows/                (project: wsl-portal)            (wsl-portal-api)
    warsignallabs-site)       React 19 + Vite                  + D1 (wsl-portal)
                                                                + R2 (wsl-portal-files)
                                                                + Resend (transactional email)
                                                                + Clerk (auth — currently DEV instance)
```

**Critical asymmetry:** the marketing site sits on GitHub Pages (no server-controlled headers, no edge compute), while the portal sits on Cloudflare's edge stack (full header control, D1, R2, Workers). This drives most of the open architectural debt — see §6.

---

## 2. Topology (target state)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Squarespace Domains  (registrar only)                               │
└─────────────────────────────────────┬────────────────────────────────┘
                                      │ NS delegation
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Cloudflare  (DNS + CDN + WAF + Transform Rules + Web Analytics)     │
│  Zone: warsignallabs.net                                             │
└─────────┬───────────────────────┬────────────────────┬───────────────┘
          │                       │                    │
          ▼                       ▼                    ▼
   GitHub Pages            Cloudflare Pages      Cloudflare Worker
   (origin, proxied)       (wsl-portal)           (wsl-portal-api)
        ▲                       ▲                    + D1 + R2
        │                       │                    + Clerk PROD
        │                       │                      (clerk.warsignallabs.net)
        │                       │
   Transform Rule          first-party Clerk
   sets HSTS, XFO,         cookies (no third-
   X-CTO, Perms-Policy,    party cookie blocking)
   response-CSP w/
   frame-ancestors
```

Two unblockers move us from current → target:

1. **Cloudflare zone activation** (Phase 0 — REM-652, requires Russ to switch nameservers at Squarespace).
2. **Clerk dev → prod migration** (in flight per `portal-app/handoff.yaml`).

---

## 3. Marketing Site (warsignallabs.net)

### Stack

| Layer | Technology |
|---|---|
| Hosting | GitHub Pages (`remeadows/warsignallabs-site`, `main` branch) |
| TLS | GitHub Pages auto-provisioned (Let's Encrypt) |
| Domain mapping | `CNAME` file → `warsignallabs.net` |
| Pages | 10 hand-written static HTML files |
| Styles | Global `styles.css` (design tokens + base components) + per-page inline `<style>` for page-specific layouts |
| JS | Single `site.js` — nav toggle + IntersectionObserver fade-in |
| Fonts | Google Fonts: IBM Plex Sans, IBM Plex Serif, IBM Plex Mono (`display=swap`) |
| Images | Self-hosted `.webp` (russ-headshot, WarSignal2, WarSignalLabs; Rusty.webp/png retained but no longer referenced) |
| Identity | Dark navy ground `#0E1726` · steel-blue accent `#6F8FB8` · burnished gold CTA `#C9A557` (no neon) |

### Page inventory (post-2026-05-05 content/tone overhaul)

Nav labels and content focus updated; file paths preserved to avoid breaking links and SEO. Primary nav order across all pages: **Services · Work · Research · Studio · About · Contact · Client Portal**.

| Nav label | File | Indexed | Purpose |
|---|---|---|---|
| Home | `index.html` | yes (priority 1.0) | Hero (one-sentence value prop), three focus areas, Observe/Analyze/Respond loop, three case-study cards (Blueprint, GW-OS, GridWatch), About-Russ teaser, contact |
| Services | `services.html` | yes (0.9) | Three service lines, engagement model, four typical packages (renamed from A/B/C/D), intake template |
| Work | `deployed-systems.html` | yes (0.9) | **Case-study hub** — Blueprint Advisory (paid, in production), GW-OS (active research), GridWatch Enterprise (concluded capability proof) |
| GridWatch Enterprise | `gridwatch-enterprise.html` | yes (0.7) | Honest case study — built solo, concluded 2025, lessons documented; no roadmap/demo CTA |
| Research | `labs.html` | yes (0.7) | Agent-communication research direction (additive-decomposition equation as centerpiece) + GW-OS callout + iOS games portfolio |
| Studio | `studio.html` | yes (0.5) | WAR SIGNAL personal music project (Spotify + Apple Music embeds) — the one page that retains stylistic personality |
| About | `warsignal-vision.html` | yes (0.6) | About Russ bio, two engines, four operating principles, methodology, security philosophy |
| App Support | `support.html` | yes (0.4) | GridWatchMatch FAQ |
| Privacy | `privacy.html` | yes (0.3) | GridWatchMatch privacy policy |
| 404 | `404.html` | `noindex` | Plain "Page not found" with home/services/contact escapes |

### SEO surface (in place)

- Per-page `<title>`, `<meta description>`, canonical URL
- OpenGraph + Twitter Card on all 8 indexed pages
- JSON-LD: `Organization` (home), `ProfessionalService` (services), `SoftwareApplication` (GridWatch)
- `robots.txt` + `sitemap.xml` (8 URLs)
- Favicon set: 16/32/512 + apple-touch-icon

### Security posture (delivered)

The marketing site delivers security posture **only** via `<meta http-equiv>` tags inside each HTML file:

```http
Content-Security-Policy: default-src 'self'; base-uri 'self'; img-src 'self' data:;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com data:; script-src 'self';
  object-src 'none'; form-action 'self'; upgrade-insecure-requests
Referrer-Policy: strict-origin-when-cross-origin
```

### Security posture (NOT delivered — see DECISIONS/0002)

The repo contains `_headers` with the *intended* full header set, but **GitHub Pages does not honor `_headers`** (that file is a Cloudflare Pages / Netlify convention). Until Cloudflare zone activation lands, these are missing on every response:

- `Strict-Transport-Security` (HSTS) — clients can be SSL-stripped on first contact
- `X-Frame-Options: DENY` — `<meta>` cannot set this; clickjacking gap
- `X-Content-Type-Options: nosniff` — `<meta>` cannot set this; MIME-sniffing gap
- `Permissions-Policy` — no camera/geo/mic/payment denial
- Response-header CSP with `frame-ancestors 'none'` — meta CSP lacks this directive
- Cache-Control / immutable hints on static assets

**Risk rating: P0** for a security-engineering practice marketing on cybersecurity competence. We document this honestly until Phase 0 ships.

---

## 4. Portal (portal.warsignallabs.net)

See `portal-app/CONTEXT.md` for canonical detail. Summary:

| Layer | Tech | Binding |
|---|---|---|
| Frontend | React 19 + Vite | Cloudflare Pages (`wsl-portal`) |
| API | Cloudflare Worker | `wsl-portal-api` on `api.warsignallabs.net` |
| Database | Cloudflare D1 | `wsl-portal` (`9b47800b-5435-4e2c-890b-e38d2eea3f6a`) |
| File storage | Cloudflare R2 | `wsl-portal-files` |
| Auth | Clerk passwordless | JWT RS256, JWKS verification |
| Email | Resend | `portal@warsignallabs.net` |

**Authoritative authorization is in D1, not Clerk.** Clerk handles authN only. All RBAC checks resolve against `users.role` and `user_workspaces.permission`. Clerk `publicMetadata` is never trusted for access decisions. Account deactivation is enforced inside the auth middleware before any route handler executes.

**File model:** workspace-isolated R2 keys (`{workspace_id}/{category}/{uuid}_{filename}`), versioned via `file_versions` table (replace-in-place, no destructive overwrite). Folder hierarchy via `folders.parent_folder_id`.

**Notification model:** fire-and-forget via `ctx.waitUntil(...)` — never blocks API response. Logged to `notifications` table.

---

## 5. Data flow — representative requests

### 5.1 Marketing page view
```
Browser ──HTTPS──▶ GitHub Pages CDN ──▶ static HTML
                       │
                       └─▶ Google Fonts (preconnect)
                       └─▶ self-hosted .webp / .css / .js
```

### 5.2 Portal file upload
```
Browser (Clerk JWT)
   │
   ├─POST /api/workspaces/:slug/files──▶ api.warsignallabs.net
   │                                          │
   │                                  Worker: requireAuth
   │                                    ├─ verify JWT (JWKS)
   │                                    ├─ resolve user via clerk_id / email / username
   │                                    ├─ check status='active' (else 403)
   │                                    ├─ check workspace permission (read|write|admin)
   │                                    │
   │                                    ├─ R2.put({workspace_id}/.../{uuid}_{filename})
   │                                    ├─ D1 INSERT files (...)
   │                                    ├─ D1 INSERT audit_log (...)
   │                                    └─ ctx.waitUntil(Resend → admins + workspace members)
   │
   └─◀ 200 { file: {...} }
```

---

## 6. Architectural Risks (tracked, current)

| ID | Risk | Severity | Owner | Mitigation path |
|---|---|---|---|---|
| AR-01 | Marketing site response headers absent (no HSTS/XFO/XCTO/Perms/frame-ancestors) | P0 | Russ + Claude | Cloudflare zone migration → Transform Rules (REM-652 → REM-656) |
| AR-02 | Clerk dev instance forces third-party cookies — Chris DePalma blocked from portal in Safari | P0 | Russ + Claude | Production Clerk + custom subdomain `clerk.warsignallabs.net` (in flight) |
| AR-03 | `_headers` file in repo is misleading — looks active but does nothing on GitHub Pages | P1 | Claude | Add comment header to file or move under `cloudflare-pages-config/` post-migration |
| AR-04 | Per-page inline `<style>` blocks remain (substantially reduced after 2026-05-05 overhaul — global tokens + base components consolidated into `styles.css`; per-page blocks now hold only page-specific layouts) | P3 | Claude | Acceptable as-is; revisit only if a page exceeds ~150 lines of inline style |
| AR-05 | No analytics on marketing site — zero visibility into who's looking, what's converting | P2 | Russ | Cloudflare Web Analytics post-migration (privacy-friendly, no JS tracker) |
| AR-06 | No CI on marketing repo — only commit + GH Pages auto-deploy. No HTML/CSS lint, no link check, no Lighthouse gate | P2 | Claude | GitHub Actions: htmlhint + lychee + lighthouse-ci |
| AR-07 | Portal `wrangler.toml` exposes `CLERK_FRONTEND_API` (dev URL `sharing-gator-67.clerk.accounts.dev`) — fine for now but rotates during prod migration | P1 | Russ + Claude | Tracked in `portal-app/handoff.yaml` Phase 3 |
| AR-08 | No staging environment for marketing site — every commit ships to prod | P3 | Claude | Branch deploy via Cloudflare Pages once zone migrated; GitHub Pages branch preview alternative |
| AR-09 | Hand-maintained sitemap.xml will drift as pages are added | P3 | Claude | Generate from filesystem in CI |
| AR-10 | `WEBSITE_OVERHAUL_PLAN.md` is the original infra plan (March 2026); content/tone overhaul (May 2026) is documented separately in `DECISIONS/0003`. Phase 5 (content) effectively complete. | P2 | Claude | Reconcile with Linear, archive `WEBSITE_OVERHAUL_PLAN.md` into `DECISIONS/` once Phase 0 + Phase 4 ship |
| AR-11 | Russ headshot (`russ-headshot.webp`) has a faint AI-generated artifact below the wall tagline — invisible at 120px circular About crop, visible at any larger crop | P3 | Russ | Re-generate or shoot a clean headshot before LinkedIn-banner / OG-share / full-bleed use |

---

## 7. Deployment

### Marketing site
```bash
# From repo root
git add <files>
git commit -m "feat(site): description (REM-XXX)"
git push origin main
# GitHub Pages picks up automatically; ~30-60s to live
```

No build step. Pages are hand-authored. CSS/JS served as-is.

### Portal frontend
```bash
cd portal-app && npm run build
npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true
```

### Portal Worker (API)
```bash
cd portal-app/worker && npx wrangler deploy
```

Worker deploys are instant and affect production immediately. No staging.

### Secrets
```bash
# Worker secrets — Russ executes (Claude advises commands)
cd portal-app/worker
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put RESEND_API_KEY
```

---

## 8. Observability (current — minimal)

| Surface | What's logged | Where |
|---|---|---|
| Marketing | None | — |
| Portal Worker | All API calls + errors | `wrangler tail` (live), Cloudflare dashboard logs |
| Portal D1 | All authz decisions, file ops | `audit_log` table (queryable) |
| Portal Resend | Email send status, delivery | Resend dashboard + `notifications` table |

**Gap:** no aggregation, no alerting. Acceptable for current scale (~5 users). Will need Logpush + a destination (BetterStack, Loki, or Cloudflare Workers Analytics Engine) before hitting double-digit clients.

---

## 9. Compliance Posture (relevant for sales conversations)

The site itself is not in a regulated environment — it's a marketing surface. But because the practice sells STIG/RMF/ATO services:

- The site **must not contradict** the security claims being sold — hence AR-01 is treated as P0.
- The portal **must demonstrate** RBAC, audit logging, encryption-in-transit, encryption-at-rest (R2 default), TLS 1.2+ — so it can be pointed to as a production reference.
- No PII or CUI ever stored. Workspaces are general-purpose document exchange.

---

## 10. Next Architectural Decisions Pending

1. **DNS migration window** — Russ-driven, requires nameserver switch at Squarespace. Schedule.
2. **Cloudflare Pages vs. keep GitHub Pages for marketing** — once zone is on Cloudflare, do we proxy GitHub Pages through Cloudflare (cheaper migration, keeps git-driven deploy) or move marketing into Cloudflare Pages (uniform with portal, native `_headers` support, branch previews)? See future ADR.
3. **Analytics provider** — Cloudflare Web Analytics is the leading candidate. Plausible second.
4. **Single shared design system** — should marketing CSS tokens and portal CSS tokens converge into a shared package? (`styles.css` already aligns visually with `portal-app/src/themes/base.css`.) Future call.

---

*Maintained by Claude (Cowork). Update on any material architectural change.*
