-- 003_role_promotions.sql — Phase 2 role changes (spec §2, Russ-approved 2026-07-18).
-- MUST only run after the narrowed authz Worker (Tasks 1-3) is deployed.
UPDATE users SET role = 'owner', updated_at = datetime('now') WHERE id = 'usr-004';  -- Chris: client -> owner
UPDATE users SET role = 'admin', updated_at = datetime('now') WHERE id = 'usr-003';  -- rmeadows: owner -> admin
