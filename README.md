# WHO GIVES A DAMN?

Single-film release site and editorial dossier by **Zhan Petrov**.

- **Title:** *WHO GIVES A DAMN?*
- **Format:** 16:9 · 24.00 fps · 50 Picture Events · ~5:00
- **Live Site:** `https://zhanpetrov.github.io/who-gives-a-damn/`

## Structure

- `index.html` — Minimalist single-film editorial page featuring the viewfinder cover frame, user-initiated screening link, complete fact-checked article, timecoded captions & transcript drawer, AI production disclosure, and primary source ledger.
- `watch.html` — Dedicated digital screening room enforcing server-verified Stripe Checkout entitlement and short-lived HMAC-signed private streaming.
- `config.live.js` / `config.preview.js` / `config.js` — Separate deployable live (pending final pricing) and preview (Stripe test-mode) configurations with zero client-side secrets or exposed media URLs.
- `worker/` — Server-side Cloudflare Worker implementing hosted Stripe Checkout, cryptographic `Stripe-Signature` webhook verification, idempotent entitlement fulfillment, and short-lived signed HTTP 206 Range streaming from private R2 storage.
