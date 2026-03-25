# WarSignalLabs.net — Website Overhaul Plan

> **Linear Project:** [WarSignalLabs Website Overhaul](https://linear.app/remeadows/project/warsignallabs-website-overhaul-fada6a147f0a)
> **Created:** 2026-03-23
> **Lead:** Russell Meadows
> **Priority:** High
> **Status:** In Progress

---

## Infrastructure Stack

```
Current:   Squarespace Domains (registrar + DNS) → GitHub Pages (hosting)
Target:    Squarespace Domains (registrar) → Cloudflare (DNS/CDN/WAF/headers) → GitHub Pages (origin)
```

- **Registrar:** Squarespace Domains (migrated from Google Domains mid-2023)
- **DNS (current):** Squarespace
- **DNS (target):** Cloudflare (free tier — WAF, DDoS, Web Analytics, Transform Rules)
- **Hosting:** GitHub Pages (repo: `remeadows/warsignallabs.net` or equivalent)
- **SSL:** GitHub Pages auto (current) → Cloudflare Full (strict) (target)
- **Tooling:** Cloudflare MCP available in Claude Code for automated zone/rule management

---

## Site Map

| Page | File | Status |
|------|------|--------|
| Homepage | `index.html` | Live |
| Services | `services.html` | Live |
| GridWatch Enterprise | `gridwatch-enterprise.html` | Live |
| Labs | `labs.html` | Live |
| Deployed Systems | `deployed-systems.html` | Live |
| Vision | `warsignal-vision.html` | Live |
| Support | `support.html` | Live |
| Privacy | `privacy.html` | Live |
| 404 | `404.html` | **Missing** |
| robots.txt | `robots.txt` | **Missing** |
| sitemap.xml | `sitemap.xml` | **Missing** |

---

## Audit Findings (30 items)

### CRITICAL — Broken / Wrong
1. Wrong email (`rmeadows@` instead of `remeadows@`) across 17 occurrences
2. Broken footer anchor links (`#consulting`, `#interactive`, `#gridwatch` don't exist)
3. Inconsistent footer nav across all pages
4. Wrong `<title>` tag on index.html ("WarSignal Vision" instead of brand title)
5. Stale files in repo: `old_index.html` (567KB), `warsignallabs.html` (571KB)

### SEO — Zero Coverage
6. No `<meta name="description">` on any page
7. No OpenGraph tags on any page
8. No Twitter Card tags on any page
9. No favicon or apple-touch-icon linked
10. No canonical URL tags
11. No robots.txt
12. No sitemap.xml
13. No analytics (GA4, Plausible, or Cloudflare Web Analytics)
14. No JSON-LD structured data

### Performance
15. Full CSS duplicated inline on every page (~10-15KB each)
16. No `loading="lazy"` on any image
17. No explicit `width`/`height` on `<img>` tags (CLS)
18. Google Fonts without `font-display: swap` (FOIT)
19. No `<link rel="preload">` for hero image

### Security / Hardening
20. No Content-Security-Policy header (impossible on GitHub Pages alone)
21. No X-Frame-Options / X-Content-Type-Options / Referrer-Policy
22. Bare mailto links (minor scraping risk)

### Content
23. No 404 page
24. Vision page is thin
25. No App Store link for GridWatchMatch
26. No standalone About/Team page

---

## Execution Plan

### Dependency Chain

```
Phase 0 (Cloudflare Migration)
    │
    ├── Phase 1 (Critical Fixes)         ← independent, start immediately
    ├── Phase 2 (SEO + Meta)             ← independent, start in parallel
    ├── Phase 3 (Performance)            ← independent
    │
    └──► Phase 4 (Security Headers)      ← BLOCKED by Phase 0
         
Phase 5 (Content Enhancements)           ← independent, backlog
```

---

## Phase 0: Cloudflare Migration

> **Parent:** [REM-652](https://linear.app/remeadows/issue/REM-652) — Priority: High — Status: Todo
> **Unlocks:** Phase 4 (Security Headers)

| Ticket | Task | Priority | Notes |
|--------|------|----------|-------|
| [REM-659](https://linear.app/remeadows/issue/REM-659) | Verify Cloudflare account and zone status | High | Use Cloudflare MCP in Claude Code |
| [REM-660](https://linear.app/remeadows/issue/REM-660) | Add zone and import DNS records | High | Cloudflare auto-scans Squarespace |
| [REM-661](https://linear.app/remeadows/issue/REM-661) | Validate imported records match GitHub Pages | High | A records: 185.199.108-111.153 |
| [REM-662](https://linear.app/remeadows/issue/REM-662) | Switch nameservers at Squarespace (manual) | High | **Requires Russ auth** at domains.squarespace.com |
| [REM-663](https://linear.app/remeadows/issue/REM-663) | Verify propagation + enable Full (strict) SSL | High | 1-24hr propagation window |

---

## Phase 1: Critical Fixes

> **Parent:** [REM-653](https://linear.app/remeadows/issue/REM-653) — Priority: Urgent — Status: Todo
> **Dependencies:** None — start immediately

| Ticket | Task | Priority | Scope |
|--------|------|----------|-------|
| [REM-664](https://linear.app/remeadows/issue/REM-664) | Fix email — replace `rmeadows@` → `remeadows@` | Urgent | 17 occurrences across all subpages |
| [REM-665](https://linear.app/remeadows/issue/REM-665) | Fix broken footer anchors → real page links | Urgent | `#consulting`→`/services.html`, `#gridwatch`→`/gridwatch-enterprise.html`, `#interactive`→`/labs.html` |
| [REM-666](https://linear.app/remeadows/issue/REM-666) | Standardize footer nav across all pages | High | Define canonical link set, apply to all 8 pages |
| [REM-667](https://linear.app/remeadows/issue/REM-667) | Fix index.html title tag | Urgent | "WarSignal Vision" → "WarSignalLabs // Cybersecurity & Network Defense" |
| [REM-668](https://linear.app/remeadows/issue/REM-668) | Remove stale files from repo | Medium | Delete `old_index.html` (567KB) + `warsignallabs.html` (571KB) |

---

## Phase 2: SEO + Meta Layer

> **Parent:** [REM-654](https://linear.app/remeadows/issue/REM-654) — Priority: High — Status: Todo
> **Dependencies:** None

| Ticket | Task | Priority | Notes |
|--------|------|----------|-------|
| [REM-669](https://linear.app/remeadows/issue/REM-669) | Add unique meta description to every page | High | Keyword-targeted, 150-160 chars |
| [REM-670](https://linear.app/remeadows/issue/REM-670) | Add OpenGraph tags to every page | High | og:title, og:description, og:image, og:url, og:site_name |
| [REM-671](https://linear.app/remeadows/issue/REM-671) | Add Twitter Card tags to every page | High | summary_large_image |
| [REM-672](https://linear.app/remeadows/issue/REM-672) | Add canonical URL tags to every page | High | Prevents duplicate content |
| [REM-673](https://linear.app/remeadows/issue/REM-673) | Add favicon + apple-touch-icon links | High | Assets generated in prior session |
| [REM-674](https://linear.app/remeadows/issue/REM-674) | Create robots.txt and sitemap.xml | High | 8 pages + support/privacy |
| [REM-675](https://linear.app/remeadows/issue/REM-675) | Add JSON-LD structured data | Medium | Organization (index), ProfessionalService (services), SoftwareApplication (gridwatch) |

---

## Phase 3: Performance

> **Parent:** [REM-655](https://linear.app/remeadows/issue/REM-655) — Priority: Medium — Status: Todo
> **Dependencies:** None

| Ticket | Task | Priority | Notes |
|--------|------|----------|-------|
| [REM-676](https://linear.app/remeadows/issue/REM-676) | Extract shared CSS to `styles.css` | Medium | ~10-15KB duplicated per page currently |
| [REM-677](https://linear.app/remeadows/issue/REM-677) | Add `loading="lazy"` to below-fold images | Medium | Rusty headshot, section images |
| [REM-678](https://linear.app/remeadows/issue/REM-678) | Add width/height to img tags | Medium | Prevents CLS during load |
| [REM-679](https://linear.app/remeadows/issue/REM-679) | Add `font-display=swap` to Google Fonts | Medium | Prevents FOIT on slow connections |
| [REM-680](https://linear.app/remeadows/issue/REM-680) | Add `<link rel="preload">` for hero image | Medium | WarSignal2.webp — improves LCP |

---

## Phase 4: Security Headers (Cloudflare)

> **Parent:** [REM-656](https://linear.app/remeadows/issue/REM-656) — Priority: High — Status: Todo
> **BLOCKED BY:** [REM-652](https://linear.app/remeadows/issue/REM-652) (Phase 0 — Cloudflare Migration)

| Ticket | Task | Priority | Notes |
|--------|------|----------|-------|
| [REM-681](https://linear.app/remeadows/issue/REM-681) | Add CSP header via Cloudflare Transform Rule | High | Impossible on GitHub Pages alone |
| [REM-682](https://linear.app/remeadows/issue/REM-682) | Add X-Frame-Options, X-Content-Type-Options, Referrer-Policy | High | Clickjacking + MIME sniffing protection |
| [REM-683](https://linear.app/remeadows/issue/REM-683) | Enable Cloudflare Web Analytics | Medium | Privacy-friendly, no JS tracker needed |
| [REM-684](https://linear.app/remeadows/issue/REM-684) | Configure Cloudflare caching rules | Medium | Static assets: CSS, images, fonts |

---

## Phase 5: Content Enhancements

> **Parent:** [REM-658](https://linear.app/remeadows/issue/REM-658) — Priority: Low — Status: Backlog
> **Dependencies:** None

| Ticket | Task | Priority | Notes |
|--------|------|----------|-------|
| [REM-685](https://linear.app/remeadows/issue/REM-685) | Create branded 404.html | Low | Cyberpunk-styled with nav back to home |
| [REM-686](https://linear.app/remeadows/issue/REM-686) | Expand Vision page | Low | Add methodology, operating principles |
| [REM-687](https://linear.app/remeadows/issue/REM-687) | Add App Store link for GridWatchMatch | Low | When Build 3 ships |
| [REM-688](https://linear.app/remeadows/issue/REM-688) | Evaluate About/Team page | Low | Enterprise credibility play |

---

## Ticket Summary

| Phase | Parent | Children | Priority | Status | Blocker |
|-------|--------|----------|----------|--------|---------|
| 0 — Cloudflare Migration | REM-652 | REM-659 through REM-663 (5) | High | Todo | — |
| 1 — Critical Fixes | REM-653 | REM-664 through REM-668 (5) | Urgent | Todo | — |
| 2 — SEO + Meta | REM-654 | REM-669 through REM-675 (7) | High | Todo | — |
| 3 — Performance | REM-655 | REM-676 through REM-680 (5) | Medium | Todo | — |
| 4 — Security Headers | REM-656 | REM-681 through REM-684 (4) | High | Todo | REM-652 |
| 5 — Content Enhancements | REM-658 | REM-685 through REM-688 (4) | Low | Backlog | — |

**Total: 6 phase parents + 30 child tasks = 36 tickets**

---

## Notes

- **Cloudflare MCP** is available in Claude Code for automated zone management and rule creation (Phase 0 + Phase 4)
- **Favicon + OG image assets** were generated in a prior optimization session and are ready to deploy
- **Project files in this repo may be stale** — the live site has diverged from `index.html` in the project knowledge. Always verify against the GitHub repo.
- The live site uses `WarSignal2.webp` as the hero image — this asset is not tracked in the project files here
- `index.html` in project files still uses old anchor-based nav; the live site uses multi-page nav

---

*Generated 2026-03-23 by Claude — WarSignalLabs Website Overhaul audit session*
