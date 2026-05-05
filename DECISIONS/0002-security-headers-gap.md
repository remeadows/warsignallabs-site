# ADR-0002: Security Headers Gap on Marketing Site

**Status:** Accepted (documents an intentional, bounded gap)
**Date:** 2026-05-02
**Decider:** Russ Meadows
**Recorder:** Claude (Cowork)
**Severity:** P0
**Linked tickets:** [REM-652](https://linear.app/remeadows/issue/REM-652) (unblocker), [REM-656](https://linear.app/remeadows/issue/REM-656) (resolution)

---

## Context

The marketing site at `warsignallabs.net` is hosted on GitHub Pages. The repo contains a `_headers` file with a complete security-header stack:

```
/*
  Content-Security-Policy: default-src 'self'; ...; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=(), browsing-topics=()
```

**Problem:** The `_headers` file format is a Cloudflare Pages / Netlify convention. **GitHub Pages does not honor it.** The file is served as a static asset (or 404) and has zero effect on response headers.

The actual security posture delivered by GitHub Pages is whatever each HTML page declares via `<meta http-equiv>` — which is limited:

| Header | Settable via `<meta>` | Currently delivered |
|---|---|---|
| Content-Security-Policy | Yes (with caveats — cannot set `frame-ancestors`, `report-uri`, sandbox in some browsers) | Yes (per-page meta tag) |
| Referrer-Policy | Yes | Yes |
| Strict-Transport-Security | **No** | **No** |
| X-Frame-Options | **No** | **No** |
| X-Content-Type-Options | **No** | **No** |
| Permissions-Policy | **No** | **No** |
| frame-ancestors directive | **No** (must be in response-header CSP) | **No** |
| Cache-Control | Limited (`<meta>` is broadly ignored by intermediaries) | Whatever GitHub Pages defaults to |

This means the live site is missing **clickjacking protection, MIME-sniffing protection, HSTS, and Permissions-Policy** despite the `_headers` file appearing to provide them.

For a security-engineering practice that markets STIG/RMF/ATO competence, this is a credibility-relevant gap — anyone running `curl -I https://warsignallabs.net` will see it.

---

## Decision

1. **Document the gap honestly** in this ADR, in `ARCHITECTURE.md` (AR-01, AR-03), and in `BACKLOG.md` (P0-3, P0-4).

2. **Add an explanatory banner** to `_headers` so future agents and contributors do not assume it is active. (P0-4)

3. **Do not migrate marketing to Cloudflare Pages just to fix this** in isolation — it would conflict with the open architectural question (P1-8) and add deploy churn. Instead, fix it as part of the planned Cloudflare zone migration (Phase 0).

4. **After Phase 0 lands**, deliver the full header stack via Cloudflare Transform Rules at the zone level. This works for every origin under `warsignallabs.net` regardless of where the origin lives (GitHub Pages, CF Pages, Worker), giving us uniform headers across all three surfaces. (P0-3 / REM-656)

5. **Keep the `<meta>` CSP and Referrer-Policy** in HTML pages even after Phase 0. Defense in depth — they're harmless and they keep posture in place if a future change moves a page off Cloudflare proxying.

6. **Remove `frame-ancestors` from the `<meta>` CSP** since it is silently ignored by browsers — leaving it in suggests it works. Move clickjacking protection entirely to the response-header CSP set by Cloudflare. (Add to P0-3 scope.)

7. **Communicate the timeline.** This gap should not exist past the next Cloudflare migration window. If Phase 0 is still not started by 2026-06-01, escalate scope: either Russ blocks an hour to migrate the zone, or we move the marketing site to Cloudflare Pages immediately as a backstop.

---

## Consequences

### Positive
- We are not pretending. The gap is documented in code (banner on `_headers`), in docs (this ADR + ARCHITECTURE + BACKLOG), and in Linear.
- The fix path is known and bounded — one DNS migration unblocks all of it.
- Cleaning up the `<meta>` CSP (remove `frame-ancestors`) prevents agents from believing posture exists where it doesn't.

### Negative
- Until Phase 0 completes, the site **is** missing headers a security-aware visitor will notice. We accept this risk because:
  - Visitors numerically are dominated by sales-cycle prospects who don't `curl -I`
  - Any prospect sharp enough to spot it is also someone Russ is comfortable explaining the migration plan to in person
  - The fix is a known, scheduled piece of work

### Things to watch
- If `_headers` *appears* to start working someday (because we accidentally start serving via CF Pages or similar), the live header set might silently change. Agents must verify with `curl -I https://warsignallabs.net/` before assuming.
- `<meta>` CSP can be defeated by an HTTP-level injection in ways that response-header CSP cannot. This is another reason the fix matters.

---

## Verification

After Phase 0 + Transform Rules deploy, confirm with:

```bash
curl -sI https://warsignallabs.net/ | grep -iE 'content-security|x-frame|x-content|referrer|permissions|strict-transport'
```

Expected (target):
```
content-security-policy: default-src 'self'; ...; frame-ancestors 'none'
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), geolocation=(), microphone=(), payment=(), usb=(), browsing-topics=()
```

Also verify:
- [securityheaders.com](https://securityheaders.com/?q=warsignallabs.net) grade A or A+
- [hstspreload.org](https://hstspreload.org/) eligibility once HSTS is in place ≥ 24 hours

---

## References

- ARCHITECTURE.md §3 (security posture delivered vs. not delivered)
- ARCHITECTURE.md §6 (AR-01, AR-03)
- BACKLOG.md (P0-3, P0-4)
- WEBSITE_OVERHAUL_PLAN.md Phase 0 + Phase 4
- [Mozilla CSP `<meta>` limitations](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [GitHub Pages — what is and isn't supported](https://docs.github.com/en/pages)
