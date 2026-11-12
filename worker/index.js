/**
 * Cloudflare Worker: Private Screening Paywall & Signed Video Streamer
 * Film: "WHO GIVES A DAMN?" by Zhan Petrov
 *
 * Security guarantees:
 * - Zero secrets, Stripe keys, or private video URLs ever appear in client code or logs.
 * - Hosted Stripe Checkout only (`POST /api/checkout`).
 * - Cryptographic `Stripe-Signature` (HMAC-SHA256 + 300s replay window) verification (`POST /api/webhook`).
 * - Strictly idempotent fulfillment keyed by Stripe `event.id` and `session.id` only after `payment_status === "paid"`.
 * - Server-enforced entitlement check (`GET /api/access`) issuing 300-second HMAC-signed `/api/stream` URLs.
 * - Private R2 video Range streaming (`GET /api/stream`) with `Cache-Control: private, no-store`.
 */

const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyStripeWebhookSignature(rawBody, sigHeader, webhookSecret, toleranceSec = 300) {
  if (!sigHeader || !webhookSecret) return { valid: false, reason: "missing_signature_or_secret" };
  const parts = sigHeader.split(",").map((p) => p.trim());
  let timestamp = "";
  const v1Sigs = [];
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === "t") timestamp = v;
    if (k === "v1") v1Sigs.push(v);
  }
  if (!timestamp || v1Sigs.length === 0) return { valid: false, reason: "malformed_header" };
  const tsNum = Number(timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > toleranceSec) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }
  const expected = await hmacHex(webhookSecret, `${timestamp}.${rawBody}`);
  const matched = v1Sigs.some((s) => timingSafeEqualStr(s, expected));
  return matched ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : allowed;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Cache-Control": "no-store",
  };
}

function jsonResp(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) return null;
  const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
  const start = startStr ? parseInt(startStr, 10) : 0;
  const end = endStr ? Math.min(parseInt(endStr, 10), totalSize - 1) : totalSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= totalSize) {
    return null;
  }
  return { offset: start, length: end - start + 1, end };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // 1. Public configuration status check (never exposes keys or media URLs)
    if (url.pathname === "/api/status" && request.method === "GET") {
      const checkoutReady =
        env.CHECKOUT_ENABLED === "true" && Boolean(env.STRIPE_SECRET_KEY) && Boolean(env.STRIPE_PRICE_ID);
      const privateHostingReady = Boolean(env.FILM_BUCKET) && Boolean(env.PLAYBACK_SIGNING_SECRET);
      return jsonResp(
        {
          film: "who-gives-a-damn",
          mode: env.STRIPE_MODE || "pending",
          checkout_ready: checkoutReady,
          private_hosting_ready: privateHostingReady,
        },
        200,
        cors
      );
    }

    // 2. Create Hosted Stripe Checkout Session
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      if (env.CHECKOUT_ENABLED !== "true" || !env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
        return jsonResp(
          {
            status: "checkout_pending",
            error: "Paid screening checkout is paused pending Stripe price and currency confirmation.",
          },
          503,
          cors
        );
      }

      const siteBase = (env.PUBLIC_SITE_URL || origin || "https://zhanpetrov.github.io/who-gives-a-damn").replace(
        /\/$/,
        ""
      );
      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("line_items[0][price]", env.STRIPE_PRICE_ID);
      params.set("line_items[0][quantity]", "1");
      params.set("success_url", `${siteBase}/watch.html?session_id={CHECKOUT_SESSION_ID}`);
      params.set("cancel_url", `${siteBase}/watch.html?canceled=1`);
      params.set("metadata[film_slug]", "who-gives-a-damn");

      const stripeApiBase = env.STRIPE_API_BASE || "https://api.stripe.com";
      const resp = await fetch(`${stripeApiBase}/v1/checkout/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!resp.ok) {
        return jsonResp({ error: "Unable to initialize hosted Checkout session." }, 502, cors);
      }
      const session = await resp.json();
      return jsonResp({ session_id: session.id, checkout_url: session.url }, 200, cors);
    }

    // 3. Cryptographically Verified & Idempotent Stripe Webhook
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      const sigHeader = request.headers.get("Stripe-Signature") || "";
      const rawBody = await request.text();
      const check = await verifyStripeWebhookSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
      if (!check.valid) {
        return jsonResp({ error: "Invalid webhook signature", reason: check.reason }, 400);
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return jsonResp({ error: "Malformed JSON" }, 400);
      }

      const eventKey = `evt:${event.id}`;
      const alreadyProcessed = await env.ENTITLEMENTS.get(eventKey);
      if (alreadyProcessed) {
        return jsonResp({ received: true, idempotent_replay: true }, 200);
      }

      const isPaidCompletion =
        (event.type === "checkout.session.completed" && event.data?.object?.payment_status === "paid") ||
        event.type === "checkout.session.async_payment_succeeded";

      if (isPaidCompletion) {
        const sessionObj = event.data.object;
        const entKey = `ent:${sessionObj.id}`;
        const existingEnt = await env.ENTITLEMENTS.get(entKey);
        if (!existingEnt) {
          const record = {
            session_id: sessionObj.id,
            film: "who-gives-a-damn",
            paid: true,
            fulfilled_at: new Date().toISOString(),
            fulfillment_count: 1,
          };
          await env.ENTITLEMENTS.put(entKey, JSON.stringify(record), {
            expirationTtl: 60 * 60 * 24 * 30, // 30-day screening pass
          });
        }
      }

      await env.ENTITLEMENTS.put(eventKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
      return jsonResp({ received: true, idempotent_replay: false }, 200);
    }

    // 4. Server-Enforced Entitlement Check -> Mints Short-Lived (300s) Signed Stream URL
    if (url.pathname === "/api/access" && request.method === "GET") {
      const sessionId = (url.searchParams.get("session_id") || "").trim();
      if (!sessionId || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
        return jsonResp({ authorized: false, error: "Valid Checkout session required." }, 401, cors);
      }

      const rawEnt = await env.ENTITLEMENTS.get(`ent:${sessionId}`);
      if (!rawEnt) {
        return jsonResp({ authorized: false, error: "No confirmed payment entitlement found." }, 403, cors);
      }
      const ent = JSON.parse(rawEnt);
      if (ent.paid !== true) {
        return jsonResp({ authorized: false, error: "Payment not settled." }, 403, cors);
      }

      if (!env.FILM_BUCKET || !env.PLAYBACK_SIGNING_SECRET) {
        return jsonResp({ authorized: true, stream_pending: true }, 200, cors);
      }

      const exp = Math.floor(Date.now() / 1000) + 300; // 5-minute short-lived signed URL
      const sig = await hmacHex(env.PLAYBACK_SIGNING_SECRET, `${sessionId}:${exp}`);
      const streamUrl = new URL("/api/stream", url.origin);
      streamUrl.searchParams.set("sid", sessionId);
      streamUrl.searchParams.set("exp", String(exp));
      streamUrl.searchParams.set("sig", sig);

      return jsonResp(
        {
          authorized: true,
          expires_in_seconds: 300,
          playback_url: streamUrl.toString(),
        },
        200,
        cors
      );
    }

    // 5. Short-Lived HMAC-Signed Private R2 Video Streamer (supports HTTP 206 Range scrubbing)
    if (url.pathname === "/api/stream" && request.method === "GET") {
      const sid = url.searchParams.get("sid") || "";
      const expStr = url.searchParams.get("exp") || "";
      const sig = url.searchParams.get("sig") || "";
      if (!sid || !expStr || !sig || !env.PLAYBACK_SIGNING_SECRET) {
        return jsonResp({ error: "Missing playback authorization." }, 401, cors);
      }

      const exp = Number(expStr);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(exp) || exp < nowSec) {
        return jsonResp({ error: "Signed playback token expired." }, 403, cors);
      }

      const expectedSig = await hmacHex(env.PLAYBACK_SIGNING_SECRET, `${sid}:${exp}`);
      if (!timingSafeEqualStr(sig, expectedSig)) {
        return jsonResp({ error: "Invalid playback signature." }, 403, cors);
      }

      // Re-enforce server-side entitlement on every stream segment request
      const rawEnt = await env.ENTITLEMENTS.get(`ent:${sid}`);
      if (!rawEnt || JSON.parse(rawEnt).paid !== true) {
        return jsonResp({ error: "Entitlement revoked or missing." }, 403, cors);
      }

      const objectKey = env.PRIVATE_VIDEO_KEY || "who-gives-a-damn-master.mp4";
      const head = await env.FILM_BUCKET.head(objectKey);
      if (!head) {
        return jsonResp({ error: "Private screening master not yet uploaded." }, 404, cors);
      }

      const rangeHeader = request.headers.get("Range");
      const range = parseRange(rangeHeader, head.size);
      if (range) {
        const obj = await env.FILM_BUCKET.get(objectKey, {
          range: { offset: range.offset, length: range.length },
        });
        return new Response(obj.body, {
          status: 206,
          headers: {
            ...cors,
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": String(range.length),
            "Content-Range": `bytes ${range.offset}-${range.end}/${head.size}`,
            "Cache-Control": "private, no-store",
          },
        });
      }

      const obj = await env.FILM_BUCKET.get(objectKey);
      return new Response(obj.body, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": String(head.size),
          "Cache-Control": "private, no-store",
        },
      });
    }

    return jsonResp({ error: "Not found" }, 404, cors);
  },
};
