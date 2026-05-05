# ADR-0003: Content & Tone Overhaul — Cyberpunk Identity Retired

**Status:** Accepted (shipped 2026-05-05 in PR #9)
**Date:** 2026-05-05
**Decider:** Russ Meadows
**Recorder:** Claude (Cowork)

---

## Context

The marketing site as built through May 2026 leaned into a deliberate cyberpunk / SOC-terminal identity:

- **Typography:** Orbitron (display), Share Tech Mono (mono/labels), Rajdhani (body)
- **Palette:** dark navy with neon cyan, magenta, amber, green accents
- **Treatments:** clip-path notched cards, blinking cursor, scanline overlay, animated grid background, fake-CLI demo blocks, ALL-CAPS `//`-prefixed kickers, color-split WAR/SIGNAL/LABS hero title, "ALL SYSTEMS OPERATIONAL" status footer
- **Tone:** terse, operator-grade. "Establish link," "Operator profile," "Operational doctrine," "Capability matrix," "Flagship product," `// FOUNDER — WARSIGNALLABS`, `[ MENU ]`, `SVC_001`–`SVC_004` service IDs

This identity was internally coherent and fit Russ's actual practice of DoD network security engineering. It also failed the **mom-test**: when Russ's mother reviewed the site, her read was "pretty, but the content doesn't make sense — it's written 100% cyberpunk and technical jargon." That feedback represented the audience Russ now needs to reach: non-profit boards (working with kids' programs) and nationwide commercial firms whose decision-makers are not in security.

A site that reads as a video game to non-technical decision-makers is a barrier between Russ and the buyers he wants. Meanwhile, the substance of the practice — DoD enterprise security engineering, paid client work for Blueprint Advisory, the GW-OS distributed agent pipeline, an emerging research line on formal models of agent communication — is genuinely strong. The wrapper was undercutting the substance.

Several inputs converged into this decision:

1. **Audience shift.** WarSignalLabs is moving from "DoD-only credibility play" to "non-profit + nationwide commercial firms + DoD." The first audience is the new gating reader.
2. **Project portfolio shift.** GridWatch Enterprise — the previous flagship — was concluded in late 2025 when the institution that motivated it chose not to adopt it. GW-OS, an active 14-agent intelligence pipeline running on Pi + Ollama, is the new flagship technical work.
3. **Research direction surfacing.** Russ is building a repeatable local-AI research pipeline that decomposes agent behavior additively (`f_final(x) ≈ f_base(x) + Δf_protocol(x) + Δf_LoRA(x)`) — work that deserves headline placement on the Research page.
4. **Visual ageing.** The cyberpunk aesthetic that fit a solo-engineering proof-of-concept now reads as a barrier in a context where buyers expect Deloitte / McKinsey Digital / Booz Allen tier polish.

---

## Decision

### Audience priority

The #1 reader is now **non-technical decision-makers at non-profits and nationwide commercial firms.** A board chair must be able to describe in plain English what WarSignalLabs does after two minutes on the site. DoD/enterprise readers still respect the substance, but they are no longer the gating audience.

### Visual identity

Retire the cyberpunk identity wholesale. Move to:

| Element | Before | After |
|---|---|---|
| Display font | Orbitron | IBM Plex Serif |
| Body font | Rajdhani | IBM Plex Sans |
| Mono font | Share Tech Mono | IBM Plex Mono (used only in technical specs / equation blocks) |
| Ground | `#050d1a` deep navy with neon overlays | `#0E1726` dark navy, no overlays |
| Primary accent | Neon cyan `#00f0ff` | Muted steel-blue `#6F8FB8` |
| CTA | Neon cyan border-button with glow | Burnished gold `#C9A557` filled button |
| Other accents | magenta `#ff00aa`, green `#39ff14`, amber `#ffaa00` | None — single-accent palette |
| Card geometry | Clip-path notched polygons | Flat or subtly-rounded rectangles |
| Background | Animated grid + scanline overlay | None (clean dark surface) |
| Section dividers | Glowing cyan/magenta gradient lines | Hairline rules + whitespace |

### Tone

Retire the operator-grade vocabulary. Replace with measured executive register: short sentences, active voice, specific nouns, acronyms defined first use. Studio (`studio.html`) is the single defensible exception that may retain stylistic personality — it is an honest synthwave / instrumental personal music project.

Hard kill-list (cyberpunk-residue grep returns zero across the marketing site after the overhaul):

- "ESTABLISH LINK," "OPERATOR PROFILE," "OPERATIONAL DOCTRINE," "CAPABILITY MATRIX," "FLAGSHIP PRODUCT," "PROOF LIBRARY," "DEPLOYED APPLICATIONS"
- `// FOUNDER — WARSIGNALLABS`, `[ MENU ]`, `SVC_001`–`SVC_004`, `// EMAIL`, `gridwatch$ status --all`
- Blinking cursor, ALL-CAPS `//`-prefixed kickers, color-split WAR/SIGNAL/LABS hero title
- "ALL SYSTEMS OPERATIONAL" status footer
- The word **cyberpunk** anywhere on the marketing pages
- Mil-com framing: "operator," "deploy" (when "ship" works), "establish"
- Hyperbole: "engineered from the ground up," "purpose-built," "tools defenders need"

### Information architecture

File paths preserved (no SEO churn, no link rot). Nav labels and content focus updated:

| Old nav label | New nav label | File |
|---|---|---|
| Services | Services | `services.html` |
| GridWatch | (removed from primary nav — exists as detail page) | `gridwatch-enterprise.html` |
| Labs | **Research** | `labs.html` |
| Studio | Studio | `studio.html` |
| Deployed | **Work** | `deployed-systems.html` |
| Vision | **About** | `warsignal-vision.html` |
| Connect | Contact | `index.html#contact` |
| Enter Portal (accent button) | **Client Portal** (plain-text item) | `https://portal.warsignallabs.net` |

New nav order across all 10 pages: **Services · Work · Research · Studio · About · Contact · Client Portal**.

### Content reframing

1. **GridWatch Enterprise** demoted from "flagship product" to honest concluded capability proof. Removed roadmap, "Request Demo" CTA, target-users section. Page now reads as a case study: built solo as a proof that one engineer could ship enterprise-class software, concluded in 2025, lessons documented and applied to the work that came after.

2. **GW-OS** promoted to flagship technical work. Surfaced as an active research case study in `deployed-systems.html#gw-os` and as an applied example on `labs.html`. Specifically: a 14-agent intelligence pipeline running on Raspberry Pi + Ollama, three stages (collection / quality control / publication), output is a daily intelligence brief published to the WSL portal. No external API calls; air-gap-compatible.

3. **Agent-communication research** surfaced as the headline of `labs.html`. Plain-English thesis: build a repeatable local-AI research pipeline that measures base-model behavior, then layers in structured corrections (protocol/prompt + LoRA/QLoRA) and measures again. The research model is presented as the additive decomposition:

   ```
   f₀(x)   = base model behavior
   Δf₁(x)  = protocol / prompt correction
   Δf₂(x)  = LoRA correction

   f₂(x)   = f₀(x) + Δf₁(x) + Δf₂(x)
   f_final(x) ≈ f_base(x) + Δf_protocol(x) + Δf_LoRA(x)
   ```

   The model is simple by design: each correction is a measurable contribution that can be attributed, isolated, and rolled back. That attribution is the property that turns a black-box workflow into a system a regulated buyer can sign off on.

4. **Blueprint Advisory** retained as the revenue-proof case study. Substance unchanged; cyberpunk dressing removed.

5. **Studio (`studio.html`)** kept as Russ's personal music project. The page retains stylistic personality (a hairline-bordered "Studio · personal music project" frame, the WAR SIGNAL artist embeds for Spotify and Apple Music) while losing the explicit "cyberpunk synthwave / mil-ambient / AI-augmented composition" descriptor — which crossed from honest-genre-label into brand jargon.

6. **Lunch Out of Landfills** is intentionally absent from the public marketing site until that work is ready to surface.

7. **Russ headshot** (`russ-headshot.webp`) replaces the Rusty cartoon on the home About section.

---

## Consequences

### Positive

- **Mom-test passable.** A non-technical board chair can now read the home page and describe the practice in plain English.
- **Substance is more visible, not less.** The technical depth — STIG compliance, FastAPI/Postgres/Supabase, edge-AI agents, formal-protocols research — is still on the page. It just isn't drowning in mil-com aesthetic.
- **Research surface added.** The agent-communication research line now has headline placement on `labs.html` with the math equation as centerpiece. Previously it was a single bullet on the methodology list.
- **GW-OS is now visible as the active flagship.** Prospects who care about modern AI infrastructure can see concrete production work that isn't a consulting deck.
- **GridWatch Enterprise is honestly framed.** "Solo capability proof, concluded 2025, lessons applied to current work" is a stronger story than "flagship product, request a demo" for a project that is not in active development.
- **Site is leaner.** PR #9: ~2,177 insertions, ~3,314 deletions. Per-page inline cyberpunk CSS duplication collapsed into the global stylesheet.
- **Visual coherence between marketing and the new headshot.** The conference-room photo's warm neutrals pair cleanly with `#0E1726` and steel-blue accent — and the wall behind Russ reads "Observe / Analyze / Respond," which is the new home-page operating-loop section header.

### Negative / tradeoffs

- **Existing brand recall lost.** Anyone who knew the WarSignalLabs site as the cyberpunk operator brand now sees a different aesthetic. Acceptable cost — the prior identity served Russ's earlier audience; the new one serves the current one.
- **Studio page lives in tonal tension** with the rest of the site. We accept this — synthwave is an honest genre label there, and the Studio page is sub-branded ("personal music project") to make the tonal shift explicit to readers.
- **Portal theme** (`portal-app/src/themes/base.css`) still uses the prior cyberpunk palette. Marketing and portal now have visually divergent surfaces. Tracked as P1-10 — decide whether to align portal to the new identity or accept divergence as a "marketing brand vs. application brand" split.
- **AI-generated headshot artifact.** The headshot wall has a faint smudged second tagline below "Observe / Analyze / Respond" — a generative-AI defect from the source image. Invisible at the 120px circular About crop. Visible at any larger crop. Tracked as AR-11; needs regeneration before LinkedIn-banner / OG-share / full-bleed use.
- **Wordmark refresh deferred.** The existing `WarSignalLabs.webp` favicon/nav logo was designed for the cyberpunk palette. It reads acceptably on the new dark navy ground but may benefit from a mark refresh in a future pass. Not blocking.

### Things to watch

- **Mom-test in the field.** The internal mom-test was a single-reader proxy. Real-world feedback from non-profit board chairs and commercial buyers will tell us whether the rewrite cleared the bar or just moved the goalposts.
- **DoD-credibility test.** A peer in the field should review the new tone and confirm the substance still reads as credible to people who already know STIG/RMF/RBAC/RLS. If it reads watered-down to that audience, we'll need to bring more technical density below the fold on `services.html` and `gridwatch-enterprise.html`.
- **Acronym drift.** The new tone defines acronyms on first use. Future content additions must follow the same rule or the readability gain decays.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep cyberpunk visual, soften copy only | Mom-test concern was driven by both copy AND visual treatment. Words alone wouldn't clear the bar. |
| Soft-pivot: drop neon but keep Orbitron + clip-path notches | Same problem at lower magnitude. The cumulative effect of the cyberpunk treatments is what reads as "video game." Removing one or two without the others doesn't change the read. |
| Light theme instead of dark | Considered. Russ leaned toward keeping the dark identity because (a) most engineering practices run dark/black with restrained accents (Deloitte's tech sites, in particular), (b) the existing logo and the new headshot's color palette both read better on dark, (c) light theme would have been a third coordinate of change on top of palette + typography. |
| Hard demote: delete `gridwatch-enterprise.html` entirely | Considered. Rejected because the technical depth on that page is real evidence of solo engineering capability — stronger as a case study than as a deletion. |
| Redirect / rename `labs.html` → `research.html` | Considered. Deferred — file path preservation across the rewrite avoided any 301-redirect work in the same PR. Can be done later if desired. |
| Consolidate marketing and portal themes in this PR | Out of scope — would have required portal redeploys and visual QA across both surfaces. Tracked separately as P1-10. |

---

## Reversibility

| Component | Reversibility |
|---|---|
| Visual identity | Easy — rolling back PR #9 restores the prior `styles.css` + per-page inline blocks. No assets were deleted. |
| Tone | Easy — same rollback. |
| Information architecture | Easy — file paths preserved; nav reorder is one-line per page. |
| Content reframing (GridWatch / GW-OS / research thesis) | Hard to revert in tone but the content itself is now load-bearing for current sales conversations. Reverting would mean re-positioning GridWatch as flagship, which is no longer accurate. |
| Headshot | Easy — `russ-headshot.webp` is one filename change away from being swapped. |

---

## Verification

After this overhaul, confirm:

- `grep -i -E "ESTABLISH LINK|OPERATOR PROFILE|OPERATIONAL DOCTRINE|CAPABILITY MATRIX|FLAGSHIP PRODUCT|SVC_0|cyberpunk" *.html | grep -v studio.html` returns no hits
- `grep -E "Orbitron|Share\\+Tech|Rajdhani" *.html` returns no hits
- All 10 pages share the same primary nav: **Services · Work · Research · Studio · About · Contact · Client Portal**
- The mom-test (a non-technical reader can describe the practice in plain English after 2 minutes)
- The DoD-credibility test (a peer in the field reads the substance as credible)

---

## References

- PR #9: [remeadows/warsignallabs-site#9](https://github.com/remeadows/warsignallabs-site/pull/9)
- `CONTEXT.md` — Brand & Voice section (load-bearing rules for future content)
- `ARCHITECTURE.md` §3 — Page inventory updated with new nav labels
- `BACKLOG.md` — P1-1, P2-3, P2-4 closed/advanced; AR-11 added
- ADR-0001 — Baseline architecture (still accurate; this overhaul did not change the deploy/infra topology)
- ADR-0002 — Security headers gap (independent; still open, blocked on Phase 0)

---

*Maintained by Claude (Cowork). Append to this ADR if the audience priority or visual identity changes again.*
