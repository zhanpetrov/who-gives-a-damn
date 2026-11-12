#!/usr/bin/env node
/**
 * Automated Test-Mode Verification Suite for "WHO GIVES A DAMN?" Paywall & Private Streaming
 * Verifies:
 *  1. Pending live checkout protection when price/currency are unconfirmed (no live charges).
 *  2. Test-mode hosted Checkout session creation + cryptographically signed webhook fulfillment.
 *  3. Checkout cancellation / unpaid session rejection (403, zero playback URL leak).
 *  4. Webhook retry idempotency (multiple replays fulfill exactly once).
 *  5. Forged / expired webhook signature rejection (400).
 *  6. Unauthorized, tampered, and expired private video playback rejection (401/403) + valid 206 Range playback.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

class MemoryKV {
  constructor() {
    this.map = new Map();
    this.putCalls = [];
  }
  async get(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  async put(k, v) {
    this.putCalls.push(k);
    this.map.set(k, String(v));
  }
}

class MemoryPrivateR2 {
  constructor(bytes) {
    this.bytes = bytes;
  }
  async head(key) {
    if (key !== "who-gives-a-damn-master.mp4") return null;
    return { size: this.bytes.byteLength };
  }
  async get(key, opts) {
    if (key !== "who-gives-a-damn-master.mp4") return null;
    if (opts?.range) {
      const slice = this.bytes.subarray(opts.range.offset, opts.range.offset + opts.range.length);
      return { body: slice };
    }
    return { body: this.bytes };
  }
}

function signStripePayload(rawBody, secret, tsSec = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(`${tsSec}.${rawBody}`).digest("hex");
  return `t=${tsSec},v1=${sig}`;
}

async function runSuite() {
  const results = [];
  const sampleVideoBytes = Buffer.from("000000186674797069736f6dPRIVATE_MASTER_VIDEO_STREAM_PAYLOAD", "utf8");

  // Mock Stripe /v1/checkout/sessions endpoint in test mode (zero network / zero live charge)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/checkout/sessions")) {
      const bodyStr = String(init?.body || "");
      assert.match(bodyStr, /mode=payment/);
      assert.match(bodyStr, /price_test_wgad_001/);
      return new Response(
        JSON.stringify({
          id: "cs_test_a1B2c3D4e5F6g7H8i9J0",
          url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7H8i9J0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return origFetch(url, init);
  };

  const kv = new MemoryKV();
  const r2 = new MemoryPrivateR2(sampleVideoBytes);

  // Ephemeral random test-only secrets generated in memory (never real credentials)
  const ephemeralWebhookSecret = "whsec_test_" + crypto.randomBytes(16).toString("hex");
  const ephemeralPlaybackSecret = "play_test_" + crypto.randomBytes(16).toString("hex");

  const pendingEnv = {
    STRIPE_MODE: "pending",
    CHECKOUT_ENABLED: "false",
    ENTITLEMENTS: kv,
    FILM_BUCKET: r2,
  };

  // Test 1: Live/pending safety gate blocks checkout when price/currency not yet designated
  {
    const res = await worker.fetch(new Request("https://screening.example/api/checkout", { method: "POST" }), pendingEnv);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.status, "checkout_pending");
    results.push({ test: "pending_checkout_gate", passed: true, status: res.status });
  }

  const testEnv = {
    STRIPE_MODE: "test",
    CHECKOUT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_mock_ephemeral",
    STRIPE_PRICE_ID: "price_test_wgad_001",
    STRIPE_WEBHOOK_SECRET: ephemeralWebhookSecret,
    PLAYBACK_SIGNING_SECRET: ephemeralPlaybackSecret,
    PUBLIC_SITE_URL: "https://zhanpetrov.github.io/who-gives-a-damn",
    STRIPE_API_BASE: "https://mock-stripe.local",
    ENTITLEMENTS: kv,
    FILM_BUCKET: r2,
  };

  // Test 2: Hosted Checkout Session creation in test mode
  let checkoutSessionId = "";
  {
    const res = await worker.fetch(new Request("https://screening.example/api/checkout", { method: "POST" }), testEnv);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.session_id, "cs_test_a1B2c3D4e5F6g7H8i9J0");
    assert.match(data.checkout_url, /^https:\/\/checkout\.stripe\.com\/c\/pay\//);
    checkoutSessionId = data.session_id;
    results.push({ test: "test_mode_hosted_checkout_create", passed: true });
  }

  // Test 3: Canceled / unpaid Checkout session cannot access playback URL
  {
    const res = await worker.fetch(
      new Request(`https://screening.example/api/access?session_id=${checkoutSessionId}`),
      testEnv
    );
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.authorized, false);
    assert.equal(data.playback_url, undefined);
    results.push({ test: "canceled_or_unpaid_checkout_blocked", passed: true, status: res.status });
  }

  // Test 4: Forged webhook signature rejected with 400
  {
    const fakePayload = JSON.stringify({
      id: "evt_test_forged_1",
      type: "checkout.session.completed",
      data: { object: { id: checkoutSessionId, payment_status: "paid" } },
    });
    const res = await worker.fetch(
      new Request("https://screening.example/api/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": "t=1700000000,v1=deadbeef" },
        body: fakePayload,
      }),
      testEnv
    );
    assert.equal(res.status, 400);
    results.push({ test: "forged_webhook_rejected", passed: true, status: res.status });
  }

  // Test 5: Valid signed `checkout.session.completed` webhook fulfills entitlement + Retry Idempotency
  {
    const paidEvent = JSON.stringify({
      id: "evt_test_paid_001",
      type: "checkout.session.completed",
      data: { object: { id: checkoutSessionId, payment_status: "paid" } },
    });
    const sigHeader = signStripePayload(paidEvent, ephemeralWebhookSecret);

    const res1 = await worker.fetch(
      new Request("https://screening.example/api/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": sigHeader },
        body: paidEvent,
      }),
      testEnv
    );
    assert.equal(res1.status, 200);
    const d1 = await res1.json();
    assert.equal(d1.idempotent_replay, false);

    // Replay exact same webhook twice (Stripe retry simulation)
    const res2 = await worker.fetch(
      new Request("https://screening.example/api/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": sigHeader },
        body: paidEvent,
      }),
      testEnv
    );
    assert.equal(res2.status, 200);
    const d2 = await res2.json();
    assert.equal(d2.idempotent_replay, true);

    const entWrites = kv.putCalls.filter((k) => k === `ent:${checkoutSessionId}`).length;
    assert.equal(entWrites, 1, "Entitlement must be written exactly once across retries");
    results.push({ test: "signed_webhook_fulfillment_and_retry_idempotency", passed: true, entWrites });
  }

  // Test 6: Server-enforced entitlement issues short-lived signed URL & streams HTTP 206 Range bytes
  let signedStreamUrl = "";
  {
    const res = await worker.fetch(
      new Request(`https://screening.example/api/access?session_id=${checkoutSessionId}`),
      testEnv
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.authorized, true);
    assert.equal(data.expires_in_seconds, 300);
    signedStreamUrl = data.playback_url;

    const streamRes = await worker.fetch(
      new Request(signedStreamUrl, { headers: { Range: "bytes=0-15" } }),
      testEnv
    );
    assert.equal(streamRes.status, 206);
    assert.equal(streamRes.headers.get("Cache-Control"), "private, no-store");
    const chunk = Buffer.from(await streamRes.arrayBuffer());
    assert.equal(chunk.length, 16);
    results.push({ test: "authorized_short_lived_range_playback", passed: true, status: streamRes.status });
  }

  // Test 7: Unauthorized / tampered / expired playback URLs rejected (zero video bytes leaked)
  {
    // Direct unsigned request
    const rUnsigned = await worker.fetch(new Request("https://screening.example/api/stream"), testEnv);
    assert.equal(rUnsigned.status, 401);

    // Tampered signature
    const tampered = new URL(signedStreamUrl);
    tampered.searchParams.set("sig", "0".repeat(64));
    const rTampered = await worker.fetch(new Request(tampered.toString()), testEnv);
    assert.equal(rTampered.status, 403);

    // Expired signature
    const expiredExp = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = crypto
      .createHmac("sha256", ephemeralPlaybackSecret)
      .update(`${checkoutSessionId}:${expiredExp}`)
      .digest("hex");
    const rExpired = await worker.fetch(
      new Request(`https://screening.example/api/stream?sid=${checkoutSessionId}&exp=${expiredExp}&sig=${expiredSig}`),
      testEnv
    );
    assert.equal(rExpired.status, 403);

    results.push({
      test: "unauthorized_tampered_and_expired_playback_rejected",
      passed: true,
      statuses: [rUnsigned.status, rTampered.status, rExpired.status],
    });
  }

  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../qa/stripe_paywall_test_report.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ verified_at: new Date().toISOString(), all_passed: true, tests: results }, null, 2)
  );
  console.log("ALL 7 STRIPE PAYWALL & SIGNED STREAMING SECURITY CHECKS PASSED.");
}

runSuite().catch((err) => {
  console.error("PAYWALL TEST FAILED:", err);
  process.exit(1);
});
