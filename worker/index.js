/**
 * Cloudflare Worker: Private Screening Paywall & Signed Video Streamer
 * Film: "WHO GIVES A DAMN?" by Zhan Petrov ($2.00 USD Screening Pass)
 *
 * Security guarantees:
 * - Zero secrets, Stripe keys, or private video URLs ever appear in client code or logs.
 * - `run_worker_first = true` ensures private video chunks are NEVER directly reachable.
 * - Hosted Stripe Checkout only (`POST /api/checkout`) at $2.00 USD (200 cents) or designated STRIPE_PRICE_ID.
 * - Cryptographic `Stripe-Signature` (HMAC-SHA256 + 300s replay window) verification (`POST /api/webhook`).
 * - Strictly idempotent fulfillment keyed by Stripe `event.id` and `session.id` only after `payment_status === "paid"`.
 * - Server-enforced entitlement check (`GET /api/access`) issuing 300-second HMAC-signed `/api/stream` URLs.
 * - Private video Range streaming (`GET|HEAD /api/stream`) with `Cache-Control: private, no-store`.
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
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
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
  return { offset: start, length: end - start + 1, end, explicitEnd: Boolean(endStr) };
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
      const unitAmount = Number(env.STRIPE_UNIT_AMOUNT || 200);
      const currency = (env.STRIPE_CURRENCY || "usd").toLowerCase();
      const priceDisplay = env.STRIPE_DISPLAY_PRICE || "$2";
      const checkoutReady =
        env.CHECKOUT_ENABLED === "true" &&
        Boolean(env.STRIPE_SECRET_KEY) &&
        Boolean(env.STRIPE_PRICE_ID || unitAmount > 0);
      const privateHostingReady =
        (Boolean(env.FILM_BUCKET) || Boolean(env.PRIVATE_ASSETS)) && Boolean(env.PLAYBACK_SIGNING_SECRET);
      return jsonResp(
        {
          film: "who-gives-a-damn",
          mode: env.STRIPE_MODE || "pending",
          price_display: priceDisplay,
          currency,
          unit_amount: unitAmount,
          checkout_ready: checkoutReady,
          private_hosting_ready: privateHostingReady,
        },
        200,
        cors
      );
    }

    // 2. Create Hosted Stripe Checkout Session ($2.00 USD / 200 cents)
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const unitAmount = String(env.STRIPE_UNIT_AMOUNT || "200");
      const currency = (env.STRIPE_CURRENCY || "usd").toLowerCase();
      if (env.CHECKOUT_ENABLED !== "true" || !env.STRIPE_SECRET_KEY) {
        return jsonResp(
          {
            status: "checkout_pending",
            price_display: env.STRIPE_DISPLAY_PRICE || "$2",
            error: "Screening pass is set to $2.00 USD; awaiting Stripe 2FA key binding to enable live card checkout.",
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
      if (env.STRIPE_PRICE_ID) {
        params.set("line_items[0][price]", env.STRIPE_PRICE_ID);
      } else {
        params.set("line_items[0][price_data][currency]", currency);
        params.set("line_items[0][price_data][unit_amount]", unitAmount);
        params.set("line_items[0][price_data][product_data][name]", "WHO GIVES A DAMN? — Digital Screening Pass");
        params.set(
          "line_items[0][price_data][product_data][description]",
          "Private 1080p HD stream with synchronized English captions (05:00, 24 fps)."
        );
      }
      params.set("line_items[0][quantity]", "1");
      params.set("success_url", `${siteBase}/watch.html?session_id={CHECKOUT_SESSION_ID}`);
      params.set("cancel_url", `${siteBase}/watch.html?canceled=1`);
      params.set("metadata[film_slug]", "who-gives-a-damn");
      params.set("metadata[price_cents]", unitAmount);

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
            amount_total: sessionObj.amount_total ?? 200,
            currency: sessionObj.currency ?? "usd",
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

      const hasStorage = Boolean(env.FILM_BUCKET) || Boolean(env.PRIVATE_ASSETS);
      if (!hasStorage || !env.PLAYBACK_SIGNING_SECRET) {
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

    // 5. Short-Lived HMAC-Signed Private Video Streamer (supports HEAD + HTTP 206 Range scrubbing)
    if (url.pathname === "/api/stream" && (request.method === "GET" || request.method === "HEAD")) {
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

      // Storage Path A: Cloudflare R2 Bucket (if bound)
      if (env.FILM_BUCKET) {
        const objectKey = env.PRIVATE_VIDEO_KEY || "who-gives-a-damn-master.mp4";
        const head = await env.FILM_BUCKET.head(objectKey);
        if (!head) {
          return jsonResp({ error: "Private screening master not yet uploaded." }, 404, cors);
        }
        if (request.method === "HEAD") {
          return new Response(null, {
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
        const range = parseRange(request.headers.get("Range"), head.size);
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

      // Storage Path B: Worker-Gated Private Chunks (`run_worker_first = true`)
      if (env.PRIVATE_ASSETS) {
        const totalSize = Number(env.PRIVATE_VIDEO_BYTES || 598400575);
        const chunkSize = Number(env.PRIVATE_CHUNK_BYTES || 4194304);
        const chunkCount = Math.ceil(totalSize / chunkSize);

        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              ...cors,
              "Content-Type": "video/mp4",
              "Accept-Ranges": "bytes",
              "Content-Length": String(totalSize),
              "Cache-Control": "private, no-store",
            },
          });
        }

        const range = parseRange(request.headers.get("Range"), totalSize);
        if (range) {
          const chunkIdx = Math.floor(range.offset / chunkSize);
          const chunkStartByte = chunkIdx * chunkSize;
          const chunkEndByte = Math.min(totalSize - 1, chunkStartByte + chunkSize - 1);
          const clampedEnd = Math.min(range.end, chunkEndByte);
          const sliceOffset = range.offset - chunkStartByte;
          const sliceLength = clampedEnd - range.offset + 1;

          const chunkName = String(chunkIdx).padStart(3, "0");
          const assetRes = await env.PRIVATE_ASSETS.fetch(new Request(`https://private.internal/v1/chunk_${chunkName}.bin`));
          if (!assetRes.ok) {
            return jsonResp({ error: "Private video segment unavailable." }, 404, cors);
          }
          const buf = new Uint8Array(await assetRes.arrayBuffer());
          const bodySlice = buf.subarray(sliceOffset, sliceOffset + sliceLength);
          return new Response(bodySlice, {
            status: 206,
            headers: {
              ...cors,
              "Content-Type": "video/mp4",
              "Accept-Ranges": "bytes",
              "Content-Length": String(bodySlice.byteLength),
              "Content-Range": `bytes ${range.offset}-${clampedEnd}/${totalSize}`,
              "Cache-Control": "private, no-store",
            },
          });
        }

        // Full sequential stream if client omits Range header
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        (async () => {
          try {
            for (let i = 0; i < chunkCount; i++) {
              const chunkName = String(i).padStart(3, "0");
              const r = await env.PRIVATE_ASSETS.fetch(new Request(`https://private.internal/v1/chunk_${chunkName}.bin`));
              if (!r.ok) break;
              const ab = await r.arrayBuffer();
              await writer.write(new Uint8Array(ab));
            }
            await writer.close();
          } catch (err) {
            await writer.abort(err);
          }
        })();

        return new Response(readable, {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": String(totalSize),
            "Cache-Control": "private, no-store",
          },
        });
      }

      return jsonResp({ error: "Private storage binding not configured." }, 503, cors);
    }

    // Explicitly block all other routes (including any direct `/v1/chunk_*.bin` paths)
    return jsonResp({ error: "Not found" }, 404, cors);
  },
};
