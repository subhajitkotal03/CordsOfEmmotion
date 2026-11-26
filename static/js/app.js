(() => {
  const byId = (id) => document.getElementById(id);

  const video = byId("cameraVideo");
  const frame = byId("videoFrame");
  const canvas = byId("captureCanvas");
  const startButton = byId("startCamera");
  const stopButton = byId("stopCamera");
  const upload = byId("imageUpload");
  const refreshButton = byId("refreshTracks");

  // --- State & Elements ---

  const AUTO_CAPTURE_DELAY_MS = 900;
  const AUTO_RETRY_DELAY_MS = 1000;

  const emotionIcons = {
    angry: "↯",
    disgust: "◉",
    fear: "⌁",
    happy: "☀",
    neutral: "◌",
    sad: "☂",
    surprise: "✦",
  };

  let cameraStream = null;
  let cameraSessionId = 0;
  let autoCaptureTimer = null;
  let cameraAbortController = null;
  let recommendationNumber = 0;
  let songPage = 0;
  let currentEmotion = "";
  let spotifyIframeApi = null;
  let spotifyController = null;
  let spotifyControllerReady = false;
  let pendingTrackUri = null;
  let pendingAutoPlay = false;
  let activePlayingUri = null;
  let playRetryTimer = null;

  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    spotifyIframeApi = IFrameAPI;
    if (pendingTrackUri && !spotifyController) {
      mountSpotifyController(pendingTrackUri);
    }
  };

  function loadSpotifyIframeApi() {
    if (document.querySelector('script[data-spotify-iframe-api="true"]')) {
      return;
    }
    const script = document.createElement("script");
    script.src = "https://open.spotify.com/embed/iframe-api/v1";
    script.async = true;
    script.dataset.spotifyIframeApi = "true";
    document.head.append(script);
  }

  function showMessage(elementId, text, type = "") {
    const element = byId(elementId);
    element.textContent = text;
    element.className = `inline-message ${type}`.trim();
    element.setAttribute("aria-live", type === "error" || type === "success" ? "polite" : "off");
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("The server returned an unreadable response.");
    }

    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.code = data.code;
      throw error;
    }

    return data;
  }

  // --- Camera & Auto-Detection ---

  function clearPendingAutoCapture() {
    if (autoCaptureTimer !== null) {
      window.clearTimeout(autoCaptureTimer);
      autoCaptureTimer = null;
    }
    if (cameraAbortController) {
      cameraAbortController.abort();
      cameraAbortController = null;
    }
  }

  function waitForVideoReady(sessionId) {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready) => {
        if (settled) {
          return;
        }
        settled = true;
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        window.clearTimeout(timeoutId);
        resolve(ready);
      };

      const onReady = () => {
        if (sessionId !== cameraSessionId || !cameraStream) {
          finish(false);
          return;
        }
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          finish(true);
        }
      };

      const timeoutId = window.setTimeout(() => {
        finish(sessionId === cameraSessionId && Boolean(cameraStream) && video.videoWidth > 0);
      }, 2000);

      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
    });
  }

  function captureFrameBlob() {
    if (!cameraStream || !video.videoWidth || !video.videoHeight) {
      return Promise.resolve(null);
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    return new Promise((resolve) => {
      canvas.toBlob((image) => resolve(image), "image/jpeg", 0.88);
    });
  }

  async function detectEmotion(image, filename, signal) {
    const form = new FormData();
    form.append("image", image, filename);
    return requestJson("/api/detect-emotion", {
      method: "POST",
      body: form,
      signal,
    });
  }

  function scheduleAutoCapture(attempt, delayMs, sessionId) {
    if (sessionId !== cameraSessionId || !cameraStream) {
      return;
    }
    if (autoCaptureTimer !== null) {
      window.clearTimeout(autoCaptureTimer);
    }
    autoCaptureTimer = window.setTimeout(() => {
      autoCaptureTimer = null;
      runAutoCapture(attempt, sessionId);
    }, delayMs);
  }

  async function runAutoCapture(attempt, sessionId) {
    if (sessionId !== cameraSessionId || !cameraStream) {
      return;
    }

    if (!video.videoWidth || !video.videoHeight) {
      byId("cameraStatus").textContent = "STARTING CAMERA";
      scheduleAutoCapture(attempt + 1, AUTO_RETRY_DELAY_MS, sessionId);
      return;
    }

    byId("cameraStatus").textContent = "DETECTING...";
    if (attempt === 1) {
      showMessage("cameraMessage", "Capturing frame and detecting your expression…");
    }

    const image = await captureFrameBlob();
    if (sessionId !== cameraSessionId || !cameraStream) {
      return;
    }

    if (!image) {
      scheduleAutoCapture(attempt + 1, AUTO_RETRY_DELAY_MS, sessionId);
      return;
    }

    cameraAbortController = new AbortController();

    try {
      const result = await detectEmotion(image, "capture.jpg", cameraAbortController.signal);
      if (sessionId !== cameraSessionId) {
        return;
      }

      stopCamera();
      await applyDetectionResult(result);
    } catch (error) {
      if (error.name === "AbortError" || sessionId !== cameraSessionId) {
        return;
      }

      if (error.code === "no_face") {
        byId("cameraStatus").textContent = "SCANNING FACE";
        if (attempt === 1 || attempt % 3 === 0) {
          showMessage(
            "cameraMessage",
            "Scanning for a face… Look toward the camera in good lighting.",
          );
        }
        scheduleAutoCapture(attempt + 1, AUTO_RETRY_DELAY_MS, sessionId);
        return;
      }

      stopCamera();
      showMessage("cameraMessage", error.message, "error");
    } finally {
      cameraAbortController = null;
    }
  }

  async function applyDetectionResult(result) {
    currentEmotion = (result.emotion || "").trim().toLowerCase();
    showResult(result);
    showMessage(
      "cameraMessage",
      `Detected ${currentEmotion || "mood"}. Loading songs below.`,
      "success",
    );
    await recommendTracks(0, currentEmotion);
    byId("discover").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMessage(
        "cameraMessage",
        "Camera access is unavailable here. Use localhost or HTTPS, or upload an image.",
        "error",
      );
      return;
    }

    const sessionId = ++cameraSessionId;
    clearPendingAutoCapture();
    startButton.disabled = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      if (sessionId !== cameraSessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      cameraStream = stream;
      video.srcObject = cameraStream;
      await video.play();

      if (sessionId !== cameraSessionId) {
        return;
      }

      frame.classList.add("camera-active");
      byId("cameraStatus").textContent = "AUTO CAPTURING";
      stopButton.disabled = false;
      showMessage("cameraMessage", "Camera started. Capturing automatically in a moment…");

      const ready = await waitForVideoReady(sessionId);
      if (sessionId !== cameraSessionId || !cameraStream) {
        return;
      }
      scheduleAutoCapture(1, ready ? AUTO_CAPTURE_DELAY_MS : AUTO_RETRY_DELAY_MS, sessionId);
    } catch (error) {
      if (sessionId !== cameraSessionId) {
        return;
      }
      startButton.disabled = false;
      let message = "Camera could not start. Check browser permissions or upload a photo instead.";

      if (error.name === "NotAllowedError") {
        message = "Camera permission was declined. Allow access or upload a photo instead.";
      }
      if (error.name === "NotFoundError") {
        message = "No camera was found. You can upload a photo instead.";
      }

      showMessage("cameraMessage", message, "error");
    }
  }

  function stopCamera() {
    cameraSessionId += 1;
    clearPendingAutoCapture();

    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
    }

    cameraStream = null;
    video.srcObject = null;
    frame.classList.remove("camera-active");
    byId("cameraStatus").textContent = "CAMERA OFF";
    stopButton.disabled = true;
    startButton.disabled = false;
  }

  async function predictUploadedImage(image, filename) {
    stopCamera();
    startButton.disabled = true;
    showMessage("cameraMessage", "Reading the uploaded photo…");

    try {
      const result = await detectEmotion(image, filename);
      await applyDetectionResult(result);
    } catch (error) {
      showMessage("cameraMessage", error.message, "error");
    } finally {
      startButton.disabled = Boolean(cameraStream);
    }
  }

  // --- Results & Track Recommendations ---

  function showResult(result) {
    byId("resultEmpty").hidden = true;
    byId("resultContent").hidden = false;
    byId("resultState").textContent = "EMOTION DETECTED";
    byId("emotionName").textContent = result.emotion;
    byId("emotionIcon").textContent = emotionIcons[result.emotion] || "✦";
  }

  async function recommendTracks(page = 0, emotion = currentEmotion) {
    const requestNumber = ++recommendationNumber;
    const activeEmotion = (emotion || "").trim().toLowerCase();
    currentEmotion = activeEmotion;
    refreshButton.disabled = true;
    showMessage(
      "tracksMessage",
      activeEmotion
        ? `Loading ${activeEmotion} songs from Spotify…`
        : "Loading songs from Spotify…",
    );

    try {
      const data = await requestJson("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, emotion: activeEmotion }),
      });

      // Ignore an older response if a newer song request has already started.
      if (requestNumber !== recommendationNumber) {
        return;
      }

      songPage = data.page;
      renderTracks(data.tracks || []);
      const resolvedEmotion = data.emotion || activeEmotion;
      const moodPrefix = resolvedEmotion ? `${resolvedEmotion} ` : "";
      const languageLabel = Array.isArray(data.languages) && data.languages.length
        ? data.languages.join(", ")
        : "Hindi, Bengali & English";
      byId("tracksSubtitle").textContent = `${data.count} ${moodPrefix}songs · ${languageLabel}`;

      if (data.count) {
        showMessage("tracksMessage", `${data.count} ${moodPrefix}songs are ready. Choose “Play here” to listen.`, "success");
      } else {
        showMessage("tracksMessage", "Spotify found no songs on this page. Refresh to try another set.");
      }
    } catch (error) {
      if (requestNumber === recommendationNumber) {
        showMessage("tracksMessage", error.message, "error");
      }
    } finally {
      if (requestNumber === recommendationNumber) {
        refreshButton.disabled = false;
      }
    }
  }

  function renderTracks(tracks) {
    const grid = byId("tracksGrid");
    grid.replaceChildren();

    if (tracks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tracks-empty surface-card";
      empty.innerHTML = "<span>♫</span><strong>No songs came back this time.</strong><p>Refresh to try another set or check your internet connection.</p>";
      grid.append(empty);
      return;
    }

    for (const track of tracks) {
      grid.append(makeTrackCard(track));
    }
  }

  function makeTrackCard(track) {
    const card = document.createElement("article");
    card.className = "track-card";

    const artwork = document.createElement("div");
    artwork.className = "track-art-wrap";

    if (track.artwork) {
      const image = document.createElement("img");
      image.className = "track-art";
      image.src = track.artwork;
      image.alt = `Album artwork for ${track.album}`;
      image.loading = "lazy";
      image.onerror = () => image.remove();
      artwork.append(image);
    } else {
      artwork.classList.add("track-art");
      artwork.textContent = "♫";
    }

    const title = document.createElement("p");
    title.className = "track-name";
    title.textContent = track.name;

    const artist = document.createElement("p");
    artist.className = "track-artist";
    artist.textContent = track.artist;

    const album = document.createElement("p");
    album.className = "track-album";
    album.textContent = track.album;

    const language = document.createElement("span");
    language.className = "track-language";
    language.textContent = track.language;

    const playButton = document.createElement("button");
    playButton.className = "track-play";
    playButton.type = "button";
    playButton.textContent = "▶ Play here";
    playButton.addEventListener("click", () => playTrack(track, card));

    const link = document.createElement("a");
    link.className = "track-open";
    link.textContent = "Open on Spotify ↗";
    link.href = track.spotify_url || "#";
    if (track.spotify_url) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.setAttribute("aria-disabled", "true");
    }

    card.append(artwork, title, artist, album, language, playButton, link);
    return card;
  }

  // --- Spotify Embedded Player ---

  function ensurePlayerMount() {
    let mount = byId("spotifyPlayerMount");
    if (mount) {
      return mount;
    }

    const playerWrap = byId("spotifyPlayerWrap");
    if (!playerWrap) {
      return null;
    }

    mount = document.createElement("div");
    mount.id = "spotifyPlayerMount";

    const existingPlayer = byId("spotifyPlayer");
    if (existingPlayer) {
      existingPlayer.replaceWith(mount);
    } else {
      playerWrap.prepend(mount);
    }

    return mount;
  }

  function mountFallbackSpotifyEmbed(trackId) {
    const mount = ensurePlayerMount();
    if (!mount) {
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.id = "spotifyPlayer";
    iframe.title = "Spotify music player";
    iframe.width = "100%";
    iframe.height = "152";
    iframe.frameBorder = "0";
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.src = `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}?autoplay=1`;
    mount.replaceChildren(iframe);
  }

  function mountSpotifyController(initialUri) {
    const mount = ensurePlayerMount();
    if (!mount || !spotifyIframeApi || spotifyController) {
      return;
    }

    const target = document.createElement("div");
    target.id = "spotifyPlayer";
    mount.replaceChildren(target);

    try {
      spotifyIframeApi.createController(
        target,
        {
          width: "100%",
          height: "152",
          uri: initialUri,
        },
        (controller) => {
          spotifyController = controller;
          const mountedIframe = mount.querySelector("iframe");
          if (mountedIframe) {
            mountedIframe.removeAttribute("loading");
          }

          controller.addListener("ready", () => {
            spotifyControllerReady = true;
            if (pendingTrackUri && pendingTrackUri !== initialUri) {
              controller.loadUri(pendingTrackUri);
            }
            if (pendingAutoPlay) {
              pendingAutoPlay = false;
              controller.play();
              schedulePlayRetry(pendingTrackUri || initialUri);
            }
          });
          controller.addListener("playback_started", (event) => {
            activePlayingUri = event?.data?.playingURI || pendingTrackUri;
          });
          controller.addListener("error", () => {
            const fallbackId = (pendingTrackUri || initialUri).split(":").pop();
            if (fallbackId) {
              spotifyController = null;
              spotifyControllerReady = false;
              mountFallbackSpotifyEmbed(fallbackId);
            }
          });
        },
      );
    } catch {
      const fallbackId = initialUri.split(":").pop();
      if (fallbackId) {
        mountFallbackSpotifyEmbed(fallbackId);
      }
    }
  }

  function schedulePlayRetry(trackUri) {
    if (playRetryTimer !== null) {
      window.clearTimeout(playRetryTimer);
    }
    playRetryTimer = window.setTimeout(() => {
      playRetryTimer = null;
      if (
        spotifyController &&
        spotifyControllerReady &&
        pendingTrackUri === trackUri &&
        activePlayingUri !== trackUri
      ) {
        spotifyController.play();
      }
    }, 350);
  }

  function playTrack(track, cardElement = null) {
    if (!track.id) {
      showMessage("tracksMessage", "Spotify could not load this song.", "error");
      return;
    }

    document.querySelectorAll(".track-card.is-playing").forEach((el) => {
      el.classList.remove("is-playing");
    });
    if (cardElement) {
      cardElement.classList.add("is-playing");
    }

    const nowPlaying = byId("nowPlayingTitle");
    if (nowPlaying) {
      nowPlaying.textContent = `${track.name} — ${track.artist}`;
    }

    const playerWrap = byId("spotifyPlayerWrap");
    const trackUri = `spotify:track:${track.id}`;
    pendingTrackUri = trackUri;
    pendingAutoPlay = true;
    activePlayingUri = null;

    playerWrap.hidden = false;
    playerWrap.scrollIntoView({ behavior: "smooth", block: "center" });

    if (spotifyController) {
      if (spotifyControllerReady) {
        spotifyController.loadUri(trackUri);
        spotifyController.play();
        schedulePlayRetry(trackUri);
        pendingAutoPlay = false;
      }
      return;
    }

    if (spotifyIframeApi) {
      mountSpotifyController(trackUri);
      return;
    }

    mountFallbackSpotifyEmbed(track.id);
    loadSpotifyIframeApi();
  }

  // --- Event Listeners & Init ---

  startButton.addEventListener("click", startCamera);
  stopButton.addEventListener("click", () => {
    stopCamera();
    showMessage("cameraMessage", "Camera stopped. Start the camera again or upload a photo.");
  });

  upload.addEventListener("change", () => {
    const image = upload.files?.[0];
    if (image) {
      predictUploadedImage(image, image.name);
    }
    upload.value = "";
  });

  refreshButton.addEventListener("click", () => {
    songPage = (songPage + 1) % 100;
    recommendTracks(songPage, currentEmotion);
  });

  document.querySelectorAll(".nav-links .nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      const menu = byId("mainNav");
      if (menu.classList.contains("show") && window.bootstrap) {
        window.bootstrap.Collapse.getOrCreateInstance(menu).hide();
      }
    });
  });

  byId("year").textContent = new Date().getFullYear();
  loadSpotifyIframeApi();
  window.addEventListener("pagehide", stopCamera);
})();
