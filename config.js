/* Active site configuration — defaults to safe live_pending until live Stripe price is set.
 * Swap with config.preview.js when running local/preview test-mode Checkout. */
window.WGAD_CONFIG = {
  filmSlug: "who-gives-a-damn",
  title: "WHO GIVES A DAMN?",
  byline: "By Zhan Petrov",
  releaseDate: "November 12, 2026",
  mode: "live_pending",
  checkoutEnabled: false,
  workerApiBase: "",
  captionsVttPath: "assets/captions.vtt",
  captionsSrtPath: "assets/captions.srt",
  coverImagePath: "assets/cover.jpg",
  pendingMessage:
    "Digital screening room ready. Private streaming is gated behind verified Stripe entitlement and opens once final screening pricing is activated.",
};
