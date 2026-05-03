/**
 * Canonical root redirect — fallback for the Cloudflare/Fastly cache-key
 * split between "/" and "/index.html".
 *
 * If a visitor lands on /index.html (or any path ending in /index.html),
 * silently 301-equivalent them to "/" so:
 *   1. The CDN only has to cache one URL key
 *   2. Bookmarks, share links, and OG cards all resolve to the canonical root
 *   3. We don't depend on the Cloudflare Page Rule being in place
 *
 * Loaded SYNCHRONOUSLY in <head> BEFORE any other scripts or content render,
 * so the redirect fires before paint — no FOUC.
 *
 * CSP-safe: external script, satisfies `script-src 'self'`.
 *
 * Once the Cloudflare 301 redirect rule is in production this script is
 * harmless redundancy — keep it as belt-and-suspenders.
 */
(function () {
  try {
    var p = window.location.pathname;
    if (p === '/index.html' || (p.length > 11 && p.slice(-11) === '/index.html')) {
      var newPath = p.slice(0, p.length - 10); // strip "index.html", keep trailing "/"
      window.location.replace(
        window.location.origin + newPath + window.location.search + window.location.hash
      );
    }
  } catch (e) { /* fail silently — never break the page over a redirect */ }
})();
