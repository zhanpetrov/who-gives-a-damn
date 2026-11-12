(function () {
  "use strict";

  const cfg = window.WGAD_CONFIG || {};
  const ytId = cfg.youtubeId || "7Q_azoXi0Jw";

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

  function initHeroYouTubeGate() {
    const gate = document.getElementById("film-gate");
    const slot = document.getElementById("hero-embed-slot");
    const watchBtn = document.getElementById("primary-watch-btn");
    if (!gate || !slot || !watchBtn) return;

    function mountEmbed() {
      if (gate.classList.contains("is-playing")) return;
      gate.classList.add("is-playing");
      slot.removeAttribute("hidden");
      const iframe = document.createElement("iframe");
      iframe.className = "yt-embed";
      iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0&modestbranding=1`;
      iframe.title = "WHO GIVES A DAMN? — A Short Film by Zhan Petrov";
      iframe.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.allowFullscreen = true;
      slot.innerHTML = "";
      slot.appendChild(iframe);
    }

    watchBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      mountEmbed();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initTranscriptDrawer();
    initHeroYouTubeGate();
  });
})();
