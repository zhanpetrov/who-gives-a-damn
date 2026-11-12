(function () {
  "use strict";

  const cfg = window.WGAD_CONFIG || {};

  function parseVtt(vttText) {
    const blocks = vttText.replace(/\r\n/g, "\n").split(/\n\n+/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const timeIdx = lines.findIndex((l) => l.includes("-->"));
      if (timeIdx === -1) continue;
      const [startRaw, endRaw] = lines[timeIdx].split("-->").map((s) => s.trim().split(" ")[0]);
      const text = lines
        .slice(timeIdx + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (text) {
        cues.push({
          start: startRaw.replace(/^00:/, "").slice(0, 5),
          end: endRaw.replace(/^00:/, "").slice(0, 5),
          text,
        });
      }
    }
    return cues;
  }

  async function initTranscriptDrawer() {
    const panel = document.getElementById("transcript-panel");
    const list = document.getElementById("cue-list");
    const btnMain = document.getElementById("toggle-transcript-btn");
    const btnHero = document.getElementById("toggle-transcript-hero");
    if (!panel || !list) return;

    let loaded = false;
    async function loadCues() {
      if (loaded) return;
      loaded = true;
      try {
        const res = await fetch(cfg.captionsVttPath || "assets/captions.vtt");
        if (!res.ok) throw new Error("VTT fetch failed");
        const vtt = await res.text();
        const cues = parseVtt(vtt);
        list.innerHTML = "";
        for (const c of cues) {
          const li = document.createElement("li");
          li.className = "cue-item";
          const tSpan = document.createElement("span");
          tSpan.className = "cue-time";
          tSpan.textContent = `${c.start} – ${c.end}`;
          const txSpan = document.createElement("span");
          txSpan.textContent = c.text;
          li.appendChild(tSpan);
          li.appendChild(txSpan);
          list.appendChild(li);
        }
      } catch {
        list.innerHTML =
          '<li class="cue-item"><span class="cue-time"> Transcript </span><span>Synchronized captions load from assets/captions.vtt.</span></li>';
      }
    }

    function toggle(openForce) {
      const willOpen = typeof openForce === "boolean" ? openForce : panel.hasAttribute("hidden");
      if (willOpen) {
        panel.removeAttribute("hidden");
        loadCues();
      } else {
        panel.setAttribute("hidden", "");
      }
      if (btnMain) {
        btnMain.setAttribute("aria-expanded", String(willOpen));
        btnMain.textContent = willOpen ? "Hide Timecoded Captions" : "Show Timecoded Captions";
      }
      if (btnHero) {
        btnHero.setAttribute("aria-expanded", String(willOpen));
      }
    }

    if (btnMain) btnMain.addEventListener("click", () => toggle());
    if (btnHero) {
      btnHero.addEventListener("click", () => {
        toggle(true);
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  async function initScreeningRoom() {
    const stage = document.getElementById("player-stage");
    if (!stage) return;

    const gateCard = document.getElementById("gate-card");
    const gateTag = document.getElementById("gate-tag");
    const gateTitle = document.getElementById("gate-title");
    const gateDesc = document.getElementById("gate-desc");
    const checkoutBtn = document.getElementById("checkout-btn");
    const player = document.getElementById("private-player");
    const backdrop = document.getElementById("screening-backdrop");
    const statusBanner = document.getElementById("screening-status");

    const params = new URLSearchParams(window.location.search);
    const sessionId = (params.get("session_id") || "").trim();
    const canceled = params.get("canceled") === "1";
    const apiBase = (cfg.workerApiBase || "").replace(/\/$/, "");
    const priceLabel = cfg.priceDisplay || "$2";

    if (canceled) {
      gateTag.textContent = "Checkout Canceled";
      gateTitle.textContent = "No Charge Was Made";
      gateDesc.textContent =
        "Your Stripe Checkout session was canceled before payment. You can read the complete essay free or start a new $2 screening checkout when ready.";
      statusBanner.textContent = "Checkout canceled — entitlement not granted.";
    }

    // If returning from Stripe Checkout with ?session_id=cs_..., verify server-side entitlement
    if (sessionId && apiBase) {
      statusBanner.textContent = "Verifying confirmed payment entitlement with screening server…";
      checkoutBtn.disabled = true;
      try {
        const res = await fetch(`${apiBase}/api/access?session_id=${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (res.ok && data.authorized && data.playback_url) {
          gateCard.hidden = true;
          if (backdrop) backdrop.hidden = true;
          player.hidden = false;
          player.src = data.playback_url;
          // Keep playback strictly user-initiated (do NOT call player.play() automatically)
          statusBanner.textContent =
            "Entitlement verified. Short-lived signed stream loaded — press Play when ready.";
          return;
        }
        gateTag.textContent = "Access Not Authorized";
        gateTitle.textContent = "Payment Verification Required";
        gateDesc.textContent =
          data.error || "This session does not have a confirmed payment entitlement.";
        statusBanner.textContent = "Playback blocked: valid server-side Stripe entitlement required.";
        checkoutBtn.disabled = false;
      } catch {
        statusBanner.textContent = "Unable to reach entitlement server.";
        checkoutBtn.disabled = false;
      }
    }

    // Probe live Worker `/api/status` so live Stripe activation flips Checkout ON immediately
    let serverCheckoutReady = Boolean(cfg.checkoutEnabled);
    let serverMode = cfg.mode || "live_pending";
    if (apiBase) {
      try {
        const stRes = await fetch(`${apiBase}/api/status`);
        if (stRes.ok) {
          const stData = await stRes.json();
          if (typeof stData.checkout_ready === "boolean") {
            serverCheckoutReady = stData.checkout_ready;
          }
          if (stData.mode) serverMode = stData.mode;
        }
      } catch {
        // Keep static fallback if offline
      }
    }

    if (!serverCheckoutReady || !apiBase) {
      if (!canceled) {
        gateTag.textContent = `Screening Pass · ${priceLabel} USD`;
        gateTitle.textContent = `Digital Screening Pass — ${priceLabel}`;
        gateDesc.textContent =
          cfg.pendingMessage ||
          "Private 1080p video hosting and signed Cloudflare playback are live; hosted $2.00 USD Stripe Checkout activates once Stripe 2FA sign-in completes.";
        statusBanner.textContent =
          "Private 1080p hosting & Cloudflare Worker live · $2.00 USD Checkout awaiting Stripe 2FA key binding (zero charges active).";
      }
      checkoutBtn.textContent = `Watch the Film — ${priceLabel} (Activating Stripe)`;
      checkoutBtn.disabled = true;
      checkoutBtn.style.opacity = "0.65";
      checkoutBtn.style.cursor = "not-allowed";
      return;
    }

    checkoutBtn.disabled = false;
    checkoutBtn.style.opacity = "1";
    checkoutBtn.style.cursor = "pointer";
    checkoutBtn.textContent = `Watch the Film — ${priceLabel}`;
    statusBanner.textContent =
      serverMode === "preview_test" || serverMode === "test"
        ? `Mode: Stripe Test-Mode Hosted Checkout (${priceLabel} USD — no real card charges).`
        : `Hosted Stripe Checkout ready (${priceLabel}.00 USD Screening Pass).`;

    checkoutBtn.addEventListener("click", async () => {
      checkoutBtn.disabled = true;
      statusBanner.textContent = `Opening hosted ${priceLabel} Stripe Checkout…`;
      try {
        const res = await fetch(`${apiBase}/api/checkout`, { method: "POST" });
        const data = await res.json();
        if (res.ok && data.checkout_url) {
          window.location.assign(data.checkout_url);
          return;
        }
        statusBanner.textContent = data.error || "Checkout is currently paused.";
        checkoutBtn.disabled = false;
      } catch {
        statusBanner.textContent = "Could not connect to Checkout endpoint.";
        checkoutBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTranscriptDrawer();
    initScreeningRoom();
  });
})();
