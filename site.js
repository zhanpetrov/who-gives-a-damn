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

    if (canceled) {
      gateTag.textContent = "Checkout Canceled";
      gateTitle.textContent = "No Charge Was Made";
      gateDesc.textContent =
        "Your Stripe Checkout session was canceled before payment. You can read the complete essay free below or start a new screening checkout when ready.";
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

    // Handle Pending vs. Active Checkout configuration cleanly
    if (!cfg.checkoutEnabled || !apiBase) {
      if (!canceled) {
        gateTag.textContent = "Screening Status · Pending Live Pricing";
        gateTitle.textContent = "Player Ready · Checkout Opens Soon";
        gateDesc.textContent =
          cfg.pendingMessage ||
          "Private video hosting and Stripe webhook verification are configured; live ticket checkout awaits final price & currency activation.";
        statusBanner.textContent =
          "Mode: Live Pending (zero live charges enabled until final Stripe price & currency are confirmed).";
      }
      checkoutBtn.textContent = "Checkout Pending Final Price";
      checkoutBtn.disabled = true;
      checkoutBtn.style.opacity = "0.65";
      checkoutBtn.style.cursor = "not-allowed";
      return;
    }

    statusBanner.textContent =
      cfg.mode === "preview_test"
        ? "Mode: Stripe Test-Mode Hosted Checkout (no real card charges)."
        : "Hosted Stripe Checkout ready.";

    checkoutBtn.addEventListener("click", async () => {
      checkoutBtn.disabled = true;
      statusBanner.textContent = "Creating hosted Stripe Checkout session…";
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
