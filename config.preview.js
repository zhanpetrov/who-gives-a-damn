/**
 * Preview / Test-Checkout Configuration — "WHO GIVES A DAMN?"
 * Connects to the Cloudflare Worker in Stripe test mode (`cs_test_...`) for
 * hosted Checkout, webhook fulfillment, cancellation, and signed Range playback testing.
 * Zero secrets or raw media URLs appear here.
 */
window.WGAD_CONFIG = {
  filmSlug: "who-gives-a-damn",
  title: "WHO GIVES A DAMN?",
  byline: "By Zhan Petrov",
  releaseDate: "November 12, 2026",
  mode: "preview_test",
  checkoutEnabled: true,
  workerApiBase: "http://127.0.0.1:8787",
  captionsVttPath: "assets/captions.vtt",
  captionsSrtPath: "assets/captions.srt",
  coverImagePath: "assets/cover.jpg",
  pendingMessage: "Test-mode screening checkout active.",
};
