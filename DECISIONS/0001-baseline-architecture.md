# ADR-0001: Baseline Architecture for warsignallabs.net

**Status:** Accepted (retroactive — documents what is actually in production as of 2026-05-02)
**Date:** 2026-05-02
**Decider:** Russ Meadows
**Recorder:** Claude (Cowork)

---

## Context

`warsignallabs.net` started as a single static marketing page in early 2024 and grew organically into three coupled surfaces:

1. A multi-page static marketing site
2. A multi-tenant client portal with auth, RBAC, file storage, and audit logging
3. A REST/JSON API serving the portal

These surfaces were built incrementally, with deployment-platform decisions made one-at-a-time as needs surfaced. This ADR retroactively documents the resulting architecture and the constraints that shaped it, so future agents have a reference point and don't re-litigate decisions that have already proven out.

---

## Decision

We run `warsignallabs.net` on a **split-platform architecture**:

| Surface | Platform | Why |
|---|---|---|
| Marketing (`warsignallabs.net`) | GitHub Pages | Free; trivial git-driven deploy; no build step; aligns with public-repo-as-source-of-truth |
| Portal (`portal.warsignallabs.net`) | Cloudflare Pages | Need React build pipeline, branch deploys, edge proximity; free tier covers current scale |
| API (`api.warsignallabs.net`) | Cloudflare Worker | Need server-side compute for auth, RBAC, R2 access; D1 + R2 are bound natively; edge-local |
| Database | Cloudflare D1 (SQLite) | Free tier covers scale; D1 binding inside Worker is zero-config; SQLite semantics fit the workload |
| Object storage | Cloudflare R2 | Egress-free; binding inside Worker; native lifecycle rules |
| Auth | Clerk (passwordless) | Avoid building auth ourselves; passwordless removes password-handling liability; free tier covers MAU |
| Email (transactional) | Resend | Cheap, fast deliverability; clean API; works inside Worker |

DNS is **currently** Squarespace authoritative (registrar default). Target state is Cloudflare authoritative — that migration is tracked separately as Phase 0.

---

## Consequences

### Positive
- **Cost:** $0/month at current scale. All free tiers.
- **Decoupling:** marketing site can be edited and deployed without touching the portal. A bad portal Worker deploy does not take down the marketing site.
- **Auth liability:** Clerk handles password storage, MFA, JWT issuance, session management. We never see a password.
- **Authoritative authorization stays ours:** Clerk does authN; D1 does authZ. We never trust Clerk publicMetadata for access decisions. This is explicit in the Worker auth middleware.
- **Edge proximity:** Worker + D1 + R2 are co-located; portal API is fast worldwide.
- **Git-driven deploy** for marketing: low ceremony, low risk.

### Negative / Tradeoffs
- **Asymmetric security capability** between the two web surfaces — see ADR-0002. Marketing site cannot set HTTP response headers; portal can. We accept this gap until the Cloudflare zone migration completes.
- **Two deploy stories** — `git push` for marketing, `wrangler deploy` for portal. Mental overhead but small.
- **Two CSS systems** — `styles.css` for marketing, `portal-app/src/themes/base.css` for portal. They visually agree but the tokens are duplicated. Tracked as P1-10.
- **Vendor concentration on Cloudflare** — Pages, Workers, D1, R2, target DNS, target WAF, target analytics. If Cloudflare has a regional outage, the portal is down. Acceptable for current customer count; revisit at $50K+ ARR.
- **No staging environment** for either surface. Every commit is a prod deploy. Acceptable while Russ is the sole reviewer; revisit when more agents/contributors come online.

### Neutral / forward-looking
- D1 is SQLite — fine until single-region write throughput becomes a constraint. Migration path is Cloudflare Hyperdrive + Postgres, documented in `portal/architecture.yaml`.
- The portal codebase is structured as a clone-ready template — env-driven config (`PORTAL_NAME`, `BRAND_COLOR`, D1 ID, R2 bucket name, Clerk app). This was a deliberate decision in the original portal architecture so that other consultant clients could be deployed off the same codebase.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Marketing on Cloudflare Pages from day 1 | Portal didn't exist yet; GitHub Pages was zero-friction for a static site. We can still migrate marketing to CF Pages later (tracked as P1-8). |
| Self-hosted on a VPS | Adds patching, monitoring, TLS rotation, scale-up burden. Not worth it for static + low-traffic-portal scale. |
| Vercel / Netlify for portal | Both viable. Cloudflare won because R2 + D1 + Workers are tightly bound — fewer integration seams. |
| Auth0 / Supabase Auth instead of Clerk | Clerk's passwordless UX is notably cleaner; React SDK is well-built; pricing competitive at our MAU. |
| Build our own auth | Strict no — auth is a liability we don't need to absorb. |

---

## Compliance and Security Posture

This architecture is appropriate for the current use case (general-purpose document exchange between Russ and a small set of clients). It is **not** currently certified for any specific regulatory regime (FedRAMP, CJIS, HIPAA, IL2/4/5/6). No CUI or PII beyond names and emails is stored. No clients have asked for compliance certification yet.

If a client engagement ever requires regulated-environment hosting (DoD CC SRG IL4+, etc.), the portal will not be hosted on this stack — it would be redeployed in a customer-controlled enclave. The current stack stays as the demo / general-business-use surface.

---

## Reversibility

| Component | Reversibility |
|---|---|
| GitHub Pages → Cloudflare Pages | Easy — git remote unchanged, just add CF Pages project pointing at repo |
| Cloudflare Worker → another Workers-compatible runtime | Easy — code is mostly platform-agnostic JS |
| D1 → Postgres | Moderate — schema is portable; need to swap query syntax; D1's `D1Database` API to be replaced |
| R2 → S3 / B2 | Easy — bucket key scheme is portable; presigned URL semantics differ but are well-understood |
| Clerk → Auth0 / Supabase | Hard — requires user migration via API; tracked in clone-ready architecture |
| Cloudflare DNS → another | Easy — registrar (Squarespace) controls NS; export zone, import elsewhere |

Bias: any future change should preserve the **D1-as-authoritative-authorization** invariant. That's the security spine of this whole system.

---

## References

- `ARCHITECTURE.md` — current detailed system description
- `portal-app/CONTEXT.md` — portal subapp detail
- `portal/architecture.yaml` — machine-readable portal architecture
- `WEBSITE_OVERHAUL_PLAN.md` — original 6-phase plan (March 2026, partial)
