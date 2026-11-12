/**
 * Live Production Configuration — "WHO GIVES A DAMN?"
 * Checkout remains safely paused (`checkoutEnabled: false`) until the live
 * Stripe price and currency are confirmed and activated.
 * Zero secrets, keys, payment details, or private video URLs are stored in client code.
 */
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
    "Digital screening room ready. Paid private streaming unlocks via Stripe Checkout as soon as final ticket pricing is enabled.",
};
