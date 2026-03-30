# AGENTS.md — Portal Agent Coordination

**Last Updated:** 2026-03-29

---

## Agent Roles

### Claude (Cowork) — Primary Architect
- Owns: Worker API, frontend React, D1 schema, RBAC design, notification system
- Deploys: Worker via `wrangler deploy`, Pages via `wrangler pages deploy`
- Access: Cloudflare MCP (D1 queries, R2), Linear MCP, Desktop Commander (Mac CLI)
- Authority: Full — architecture decisions, code, deploy, Linear updates

### Codex CLI — Execution Support
- Owns: Batch file operations, refactors, test scaffolding
- Boundary: Code changes only — no deploy, no D1 mutations, no secret management
- Handoff: Via CONTEXT.md + specific task description

### Human (Russ) — Operator
- Owns: Cloudflare dashboard (zone config, DNS, Transform Rules), Clerk dashboard, Resend dashboard, domain registrar
- Authority: Final approval on all architectural changes, secret provisioning, production verification

---

## Task Boundaries

| Action | Claude | Codex | Russ |
|--------|--------|-------|------|
| D1 schema changes | Yes | No | Verify |
| Worker code changes | Yes | Yes (review) | Verify |
| Frontend code changes | Yes | Yes (review) | Verify |
| Deploy to Cloudflare | Yes (via Desktop Commander) | No | Fallback |
| Manage secrets | No (advise command) | No | Execute |
| DNS changes | No (advise records) | No | Execute |
| Clerk config | No (advise settings) | No | Execute |
| Linear ticket management | Yes | No | Verify |
| Git commit/push | Yes | Yes | Verify |

---

## Linear Integration

**Workspace:** [remeadows](https://linear.app/remeadows)
**Team:** Remeadows
**Project:** [Client Portal (portal.warsignallabs.net)](https://linear.app/remeadows/project/client-portal-portalwarsignallabsnet-01fa033a)
**Project ID:** `01fa033a-8551-4174-9644-8210d0663dff`

### Completed Tickets (v0.1.0)

| Ticket | Title | Status | Date |
|--------|-------|--------|------|
| REM-689 | Day 1: Foundation — Scaffold, D1, R2, Clerk, DNS | Done | 2026-03-25 |
| REM-690 | Day 2: Auth + API Core — Clerk SDK, RBAC, Workspace Endpoints | Done | 2026-03-29 |
| REM-691 | Day 3: File Management + Admin Pages | Done | 2026-03-29 |
| REM-692 | Day 4: Polish + Security Hardening | Done | 2026-03-29 |
| REM-693 | Day 5: Buffer + Dress Rehearsal | Done | 2026-03-29 |
| REM-694 | Fix zone-level CSP blocking Clerk | Done | 2026-03-29 |

### Commit History (Portal)

| Hash | Message |
|------|---------|
| `973bc27` | Add client portal architecture v2.0, gitignore, and planning docs |
| `7e87b3a` | Build client portal: full-stack React + CF Workers app (REM-691) |
| `fa7a3a6` | Harden portal RBAC: D1-authoritative auth, workspace-level permissions |
| `15017f3` | Add email notification system via Resend for portal events |
| `ee3b297` | Ensure admins always receive notifications regardless of actor status |
| `b9ddb35` | Add file versioning: replace-in-place with version history |
| `70e3855` | Fix CORS: add PUT to allowed methods for file replacement |

---

## Handoff Protocol

When handing work between agents:

1. **Read CONTEXT.md first** — contains stack, schema, endpoints, and architecture decisions
2. **Check Linear** — query project `Client Portal (portal.warsignallabs.net)` for open tickets
3. **Never modify auth flow** without reading the full `requireAuth()` function in `worker/index.js`
4. **Never deploy secrets** — advise the `wrangler secret put` command, let Russ execute
5. **Test before deploy** — Worker deploys are instant and affect production immediately
6. **Commit references** — include Linear ticket IDs in commit messages when applicable

---

## Security Constraints

- D1 is authoritative for all access decisions — never trust Clerk publicMetadata
- Account deactivation is enforced at auth level, not route level
- All file operations are audit-logged
- CORS is locked to specific methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
- JWT verification uses RS256 with JWKS rotation support
- No username/password — Clerk passwordless only
- Admin nav hidden from client-role users at frontend level AND enforced at API level

---

*Generated 2026-03-29 by Claude (Cowork)*
