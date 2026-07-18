/**
 * WarSignalLabs Portal API Worker — entry point.
 * See worker/src/router.js for the route dispatch, worker/src/routes/*.js
 * for individual handlers, and worker/src/{cors,auth,audit,notify}.js for
 * shared helpers.
 *
 * Bindings (configured in wrangler.toml):
 *   - DB: D1 database (wsl-portal)
 *   - FILES: R2 bucket (wsl-portal-files)
 *   - CLERK_SECRET_KEY: secret (for Backend API user lookup)
 *   - CLERK_FRONTEND_API: var
 *   - RESEND_API_KEY: secret (for email notifications via Resend)
 *   - RESEND_FROM_EMAIL: var
 *   - RESEND_FROM_NAME: var
 *   - WSL_SERVICE_KEY: secret (GW-OS brief ingest)
 */

export { default } from './src/router.js'
