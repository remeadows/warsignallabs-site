# AGENTS.md — warsignallabs.net (root)

**Scope:** every agent operating on the `warsignallabs.net` repo — marketing site AND portal subapp.
**Last updated:** 2026-05-05

This file defines who does what, and **where the boundaries are between agents**. Read it before starting a task. Subapp-specific overrides live in `portal-app/AGENTS.md` and they take precedence inside `portal-app/`.

---

## 1. Agent Roster

### Russ Meadows — Operator / Final Authority
- **Owns:** all production credentials, Cloudflare dashboard, Squarespace registrar, Clerk dashboard, Resend dashboard, GitHub repo permissions, App Store Connect, all financial decisions
- **Veto:** any architectural change, any deploy
- **Cannot delegate:** nameserver changes, secret provisioning, OAuth client creation, App Store submission

### Claude (Cowork) — Primary Architect / Executor
- **Owns:** code on disk, doc maintenance, Linear ticket lifecycle, deploys via `wrangler` (advised; Russ executes secrets), git commits and pushes
- **Authority:** propose architecture, write/edit any file in repo, open and close Linear tickets, run any `wrangler deploy` for non-secret changes, query D1, query Cloudflare API via MCP
- **Boundary:** never executes a financial action, never runs `wrangler secret put`, never modifies registrar/DNS-at-Squarespace, never touches Clerk dashboard config

### Codex CLI — Execution Support (sparingly)
- **Owns:** mechanical refactors, batch find/replace, test scaffolding when explicitly handed a task
- **Boundary:** code-only, no deploy, no D1 mutations, no secret access, no doc generation
- **Handoff protocol:** receives explicit prompt + file list + acceptance criteria; never runs autonomously

### Gemini / other LLMs — Comparison / Verification
- **Used for:** second opinion on architecture proposals, alternate phrasing on copy, code review of sensitive paths (auth middleware, CSP definitions)
- **Boundary:** advisory only — never gets write access to the repo

---

## 2. Authority Matrix

| Action | Russ | Claude | Codex |
|---|---|---|---|
| Edit marketing HTML/CSS/JS | ✓ | ✓ | ✓ (review only) |
| Add a new marketing page | ✓ | ✓ | — |
| Edit portal frontend code | ✓ | ✓ | ✓ (review only) |
| Edit portal Worker code | ✓ | ✓ | ✓ (review only) |
| Modify D1 schema | ✓ | ✓ | — |
| Run D1 mutations (INSERT/UPDATE/DELETE) | ✓ | ✓ | — |
| Run D1 read queries | ✓ | ✓ | — |
| Deploy Worker (`wrangler deploy`) | ✓ | ✓ | — |
| Deploy Pages (`wrangler pages deploy`) | ✓ | ✓ | — |
| `wrangler secret put` | ✓ | — (advise only) | — |
| Cloudflare DNS changes | ✓ | ✓ (via MCP, with explicit user OK) | — |
| Squarespace registrar / nameserver | ✓ | — | — |
| Clerk dashboard config | ✓ | — (advise only) | — |
| Resend dashboard config | ✓ | — (advise only) | — |
| Git commit | ✓ | ✓ | ✓ |
| Git push to `main` | ✓ | ✓ | — |
| Linear ticket create/update/close | ✓ | ✓ | — |
| App Store submission | ✓ | — | — |

---

## 3. File Ownership (where things live, who edits)

| Path | Primary Owner | Notes |
|---|---|---|
| `*.html`, `styles.css`, `site.js` | Claude | Marketing site source. Russ reviews on PRs. |
| `_headers`, `robots.txt`, `sitemap.xml`, `CNAME` | Claude | Site infra files. |
| `CONTEXT.md`, `ARCHITECTURE.md`, `AGENTS.md`, `BACKLOG.md` | Claude | Maintained doc set. |
| `HANDOFF.md` | Claude (writer), Russ (reader) | **Updated every session.** |
| `SECURITY.md` | Russ (owns text), Claude (drafts) | Public-facing policy. Russ approves wording. |
| `WEBSITE_OVERHAUL_PLAN.md` | Claude | Now historical — superseded by `BACKLOG.md` + Linear + `DECISIONS/0003`. |
| `DECISIONS/*.md` | Claude (drafts), Russ (approves) | ADRs — append-only. |
| `russ-headshot.webp` | Russ | Professional headshot — Russ owns regeneration; Claude wires references. |
| `portal-app/**` | See `portal-app/AGENTS.md` | Portal subapp scope. |
| `portal/architecture.yaml` | Claude | Machine-readable architecture spec. |
| `*.webp`, `*.png` | Russ | Brand assets — Claude does not modify. |

---

## 4. Task Routing — "Who should do this?"

| If the task is… | Route to… |
|---|---|
| "Edit copy on the home page" | Claude (must follow Brand & Voice rules in `CONTEXT.md` — measured executive register, no cyberpunk/mil-com framing) |
| "Add a new marketing page for X" | Claude (proposes structure first, gets Russ approval, then builds) |
| "Bulk find-and-replace `X` → `Y`" | Codex (mechanical, well-bounded) |
| "Refactor `index.html` inline styles into a shared file" | Claude (architectural — needs judgment about what stays inline) |
| "Investigate why a portal user can't log in" | Claude (read-only first; never touches Clerk dashboard) |
| "Switch nameservers" | Russ — Claude advises records to add |
| "Provision a new Worker secret" | Russ — Claude advises the `wrangler secret put` command |
| "Decide whether to migrate marketing off GitHub Pages" | Claude proposes ADR; Russ approves |
| "Run a Lighthouse audit" | Claude |
| "Create a new client workspace" | Claude (D1 INSERT + email Russ for confirmation) |
| "Add a recurring scheduled task" | Claude (uses scheduled-tasks MCP after explicit user OK) |

---

## 5. Coordination Rules — preventing agent drift

### 5.1 Read before write
Every session must start with:
1. `HANDOFF.md` (root) — current state
2. `BACKLOG.md` — open work
3. If touching the portal: `portal-app/CONTEXT.md` + `portal-app/handoff.yaml`
4. `git status` + `git log -10` — what's actually in the working tree

### 5.2 Write before exit
Every session must end with:
1. `git status` clean (committed or explicitly noted as WIP)
2. `HANDOFF.md` updated with what was done, what's blocked, what's next
3. Linear tickets reflect actual state
4. If you discovered new architectural risk, add it to `ARCHITECTURE.md` §6

### 5.3 Never silently override
- Don't change auth middleware without flagging it
- Don't modify D1 schema without an ADR
- Don't change CSP without verifying both `<meta>` and `_headers` (and noting which one is live — see `DECISIONS/0002`)
- Don't push directly without referencing a Linear ticket in the commit message

### 5.4 Boundary on autonomous action
Claude may act autonomously on:
- Reads (any file, D1 SELECT, Cloudflare API list operations)
- Doc maintenance (CONTEXT, ARCHITECTURE, HANDOFF, BACKLOG, AGENTS, ADRs)
- Code edits in working tree (uncommitted)
- `git commit` (with Linear ref)

Claude requires explicit user confirmation for:
- `git push`
- `wrangler deploy` (Worker or Pages)
- D1 mutations
- Linear ticket state transitions to "Done"
- Any action that touches a third-party service through the user's account

### 5.5 Multi-agent task example (canonical pattern)

> "Add a new case study page for Customer Acme."

1. **Claude** reads `index.html`, `deployed-systems.html`, the existing case study layout, and styles.
2. **Claude** drafts the new page structure + copy, opens Linear ticket REM-XXX.
3. **Russ** reviews the structure + facts about Acme; corrects copy.
4. **Claude** writes final HTML, updates `sitemap.xml`, links from `deployed-systems.html` index.
5. **Codex** (optional) does the mechanical sitemap entry + footer link insertion across pages.
6. **Claude** runs link check + previews locally, commits with `feat(site): add Acme case study (REM-XXX)`.
7. **Russ** approves the push.
8. **Claude** pushes; verifies live; closes Linear ticket; updates `HANDOFF.md`.

---

## 6. Linear Integration

- **Workspace:** [remeadows](https://linear.app/remeadows)
- **Team:** Remeadows
- **Marketing site project:** [WarSignalLabs Website Overhaul](https://linear.app/remeadows/project/warsignallabs-website-overhaul-fada6a147f0a)
- **Portal project:** [Client Portal (portal.warsignallabs.net)](https://linear.app/remeadows/project/client-portal-portalwarsignallabsnet-01fa033a)

Every commit that maps to a ticket should reference the `REM-XXX` ID. Every ticket state transition should be reflected in `HANDOFF.md`.

---

## 7. Escalation

If an agent is uncertain whether an action is in-bounds, the rule is:

1. **Stop.**
2. Ask Russ in chat with: the proposed action, the affected surface, the reversibility, the security impact.
3. Wait for explicit "yes."

Bias toward asking. Reversibility on a static marketing site is high; reversibility on a Worker deploy or a D1 mutation is low.

---

*If this file becomes wrong, fix it. Stale agent rules are how multi-agent systems break.*
