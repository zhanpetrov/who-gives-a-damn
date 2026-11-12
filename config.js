/* Active site configuration — $2.00 USD Digital Screening Pass.
 * Private 1080p stream & Cloudflare Worker (`workerApiBase`) are live;
 * `site.js` checks `/api/status` dynamically and activates Hosted Stripe Checkout
 * automatically as soon as Stripe secret & webhook keys are bound on the Worker. */
window.WGAD_CONFIG = {
  filmSlug: "who-gives-a-damn",
  title: "WHO GIVES A DAMN?",
  byline: "By Zhan Petrov",
  releaseDate: "November 12, 2026",
  priceDisplay: "$2",
  priceCents: 200,
  currency: "USD",
  mode: "live_pending",
  checkoutEnabled: false,
  workerApiBase: "https://who-gives-a-damn-screening.zhanpetrov8.workers.dev",
  captionsVttPath: "assets/captions.vtt",
  captionsSrtPath: "assets/captions.srt",
  coverImagePath: "assets/cover.jpg",
  pendingMessage:
    "Digital Screening Pass: $2.00 USD. Private 1080p hosting and signed Cloudflare playback are live; hosted card checkout opens immediately once Stripe 2FA sign-in completes.",
};
