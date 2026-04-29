(() => {
  const CLEANUP_KEY = "__buzzBusterCleanup";

  if (typeof window[CLEANUP_KEY] === "function") {
    try {
      window[CLEANUP_KEY]();
    } catch (_error) {
      // Ignore stale cleanup failures after an extension reload.
    }
  }

  const DEFAULT_SETTINGS = {
    buzzBusterEnabled: false,
    minDelay: 30,
    maxDelay: 120,
    killedCount: 0
  };

  const MIN_DELAY_SECONDS = 5;
  const MAX_DELAY_SECONDS = 7200;
  const MAX_Z_INDEX = 2147483647;

  const IDS = {
    style: "buzz-buster-style",
    mosquito: "buzz-buster-mosquito",
    racketPrompt: "buzz-buster-racket-prompt"
  };

  const CLASSES = {
    racketArmed: "buzz-buster-racket-armed",
    mosquitoHit: "buzz-buster-hit",
    promptNudge: "buzz-buster-racket-prompt--nudge",
    splat: "buzz-buster-splat"
  };

  const ASSETS = {
    mosquito: "assets/mosquito.png",
    racketCursor: "assets/racket-cursor.png",
    buzz: "assets/mosquito-buzz.mp3",
    miss: "assets/slap.mp3",
    hit: "assets/slap-ahh.mp3"
  };

  let state = { ...DEFAULT_SETTINGS };
  let mosquitoTimer = null;
  let mosquitoElement = null;
  let racketPromptElement = null;
  let animationFrame = null;
  let buzzAudio = null;
  let lastFrameTime = 0;
  let mousePosition = null;
  let pendingSpawn = false;
  let racketArmed = false;
  let destroyed = false;

  const motion = {
    x: 0,
    y: 0,
    vx: 120,
    vy: 90
  };

  window[CLEANUP_KEY] = cleanup;
  init();

  function init() {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    addChromeListener(() => chrome.runtime.onMessage.addListener(handleRuntimeMessage));
    addChromeListener(() => chrome.storage.onChanged.addListener(handleStorageChange));

    storageGet(DEFAULT_SETTINGS, (items) => {
      state = normalizeSettings(items);
      if (state.buzzBusterEnabled) {
        startMode();
      }
    });
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "START_BUZZ_BUSTER_MODE") {
      state = normalizeSettings({
        ...state,
        ...message.payload,
        buzzBusterEnabled: true
      });
      startMode();
      sendResponse({ ok: true, state: getPublicState() });
      return false;
    }

    if (message.type === "STOP_BUZZ_BUSTER_MODE") {
      state.buzzBusterEnabled = false;
      stopMode();
      sendResponse({ ok: true, state: getPublicState() });
      return false;
    }

    if (message.type === "MOSQUITO_PING") {
      sendResponse({ ok: true, state: getPublicState() });
      return false;
    }

    return false;
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    const wasEnabled = state.buzzBusterEnabled;
    const previousMin = state.minDelay;
    const previousMax = state.maxDelay;
    const nextState = { ...state };

    if (changes.buzzBusterEnabled) {
      nextState.buzzBusterEnabled = Boolean(changes.buzzBusterEnabled.newValue);
    }

    if (changes.minDelay) {
      nextState.minDelay = changes.minDelay.newValue;
    }

    if (changes.maxDelay) {
      nextState.maxDelay = changes.maxDelay.newValue;
    }

    if (changes.killedCount) {
      nextState.killedCount = changes.killedCount.newValue;
    }

    state = normalizeSettings(nextState);

    if (!wasEnabled && state.buzzBusterEnabled) {
      startMode();
      return;
    }

    if (wasEnabled && !state.buzzBusterEnabled) {
      stopMode();
      return;
    }

    if (
      state.buzzBusterEnabled &&
      !mosquitoElement &&
      (previousMin !== state.minDelay || previousMax !== state.maxDelay)
    ) {
      scheduleNextMosquito();
    }
  }

  function startMode() {
    if (!mosquitoElement) {
      scheduleNextMosquito();
    }
  }

  function stopMode() {
    state.buzzBusterEnabled = false;
    pendingSpawn = false;
    clearMosquitoTimer();
    removeMosquito();
    removeRacketPrompt();
    disarmRacket();
    removeStyles();
  }

  function scheduleNextMosquito() {
    clearMosquitoTimer();

    if (!state.buzzBusterEnabled || mosquitoElement || destroyed) {
      return;
    }

    mosquitoTimer = window.setTimeout(showMosquito, getRandomDelayMs());
  }

  function showMosquito() {
    clearMosquitoTimer();

    if (!state.buzzBusterEnabled || mosquitoElement || destroyed) {
      pendingSpawn = false;
      return;
    }

    if (document.hidden) {
      pendingSpawn = true;
      return;
    }

    if (!injectStyles()) {
      return;
    }

    const host = getHostElement();
    if (!host) {
      return;
    }

    disarmRacket();
    showRacketPrompt();
    if (destroyed) {
      return;
    }
    pendingSpawn = false;

    const wrapper = document.createElement("div");
    wrapper.id = IDS.mosquito;
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "Swat mosquito");

    const image = document.createElement("img");
    const mosquitoUrl = getAssetUrl(ASSETS.mosquito);
    if (!mosquitoUrl) {
      return;
    }
    image.src = mosquitoUrl;
    image.alt = "";
    image.draggable = false;
    wrapper.appendChild(image);

    wrapper.addEventListener("click", killMosquito);
    wrapper.addEventListener("keydown", handleMosquitoKeydown);

    const size = getMosquitoSize();
    wrapper.style.setProperty("width", `${size}px`, "important");
    mosquitoElement = wrapper;
    host.appendChild(wrapper);

    resetMotion(size);
    applyMosquitoPosition();
    startBuzzSound();
    startFlight();
    addActivePageListeners();
  }

  function handleMosquitoKeydown(event) {
    if (event.key === "Enter" || event.key === " ") {
      killMosquito(event);
    }
  }

  function killMosquito(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!mosquitoElement) {
      return;
    }

    if (!racketArmed) {
      nudgeRacketPrompt();
      return;
    }

    const deadElement = mosquitoElement;
    const rect = deadElement.getBoundingClientRect();
    const splatX = rect.left + rect.width / 2;
    const splatY = rect.top + rect.height / 2;

    mosquitoElement = null;
    stopFlight();
    stopBuzzSound();
    removeActivePageListeners();
    removeRacketPrompt();
    disarmRacket();
    playOneShot(ASSETS.hit, 0.62);
    showSplat(splatX, splatY);
    incrementKillCount();

    deadElement.style.setProperty("--bb-hit-x", `${motion.x}px`);
    deadElement.style.setProperty("--bb-hit-y", `${motion.y}px`);
    deadElement.classList.add(CLASSES.mosquitoHit);
    window.setTimeout(() => deadElement.remove(), 170);

    scheduleNextMosquito();
  }

  function removeMosquito() {
    stopFlight();
    stopBuzzSound();
    removeRacketPrompt();
    disarmRacket();
    removeActivePageListeners();

    if (mosquitoElement) {
      mosquitoElement.remove();
      mosquitoElement = null;
    }
  }

  function addActivePageListeners() {
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("resize", keepMosquitoInViewport, { passive: true });
    document.addEventListener("click", handleRacketMissClick, true);
  }

  function removeActivePageListeners() {
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("resize", keepMosquitoInViewport);
    document.removeEventListener("click", handleRacketMissClick, true);
  }

  function startFlight() {
    stopFlight();
    lastFrameTime = performance.now();
    animationFrame = window.requestAnimationFrame(flightTick);
  }

  function stopFlight() {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  function flightTick(timestamp) {
    if (!mosquitoElement) {
      return;
    }

    const delta = Math.min(0.05, Math.max(0.001, (timestamp - lastFrameTime) / 1000));
    lastFrameTime = timestamp;

    steerAwayFromMouse(delta);
    addRandomDrift(delta);
    clampVelocity();

    motion.x += motion.vx * delta;
    motion.y += motion.vy * delta;
    bounceWithinViewport();
    applyMosquitoPosition(timestamp);

    animationFrame = window.requestAnimationFrame(flightTick);
  }

  function steerAwayFromMouse(delta) {
    if (!mousePosition || !mosquitoElement) {
      return;
    }

    const size = getCurrentMosquitoSize();
    const centerX = motion.x + size / 2;
    const centerY = motion.y + size / 2;
    const dx = centerX - mousePosition.x;
    const dy = centerY - mousePosition.y;
    const distance = Math.hypot(dx, dy);
    const repelRadius = 150;

    if (distance <= 0 || distance > repelRadius) {
      return;
    }

    const force = ((repelRadius - distance) / repelRadius) * 360;
    motion.vx += (dx / distance) * force * delta;
    motion.vy += (dy / distance) * force * delta;
  }

  function addRandomDrift(delta) {
    motion.vx += (Math.random() - 0.5) * 78 * delta;
    motion.vy += (Math.random() - 0.5) * 78 * delta;
  }

  function clampVelocity() {
    const speed = Math.hypot(motion.vx, motion.vy);
    const minSpeed = 78;
    const maxSpeed = 210;

    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      motion.vx *= scale;
      motion.vy *= scale;
      return;
    }

    if (speed < minSpeed) {
      const angle = Math.random() * Math.PI * 2;
      motion.vx += Math.cos(angle) * minSpeed * 0.35;
      motion.vy += Math.sin(angle) * minSpeed * 0.35;
    }
  }

  function bounceWithinViewport() {
    if (!mosquitoElement) {
      return;
    }

    const size = getCurrentMosquitoSize();
    const maxX = Math.max(8, window.innerWidth - size - 8);
    const maxY = Math.max(8, window.innerHeight - size - 8);

    if (motion.x < 8) {
      motion.x = 8;
      motion.vx = Math.abs(motion.vx);
    } else if (motion.x > maxX) {
      motion.x = maxX;
      motion.vx = -Math.abs(motion.vx);
    }

    if (motion.y < 8) {
      motion.y = 8;
      motion.vy = Math.abs(motion.vy);
    } else if (motion.y > maxY) {
      motion.y = maxY;
      motion.vy = -Math.abs(motion.vy);
    }
  }

  function applyMosquitoPosition(timestamp = performance.now()) {
    if (!mosquitoElement) {
      return;
    }

    const flip = motion.vx < 0 ? -1 : 1;
    const wiggle = Math.sin(timestamp / 65) * 4.5;
    mosquitoElement.style.transform = `translate3d(${motion.x}px, ${motion.y}px, 0) scaleX(${flip}) rotate(${wiggle}deg)`;
  }

  function resetMotion(size) {
    const maxX = Math.max(8, window.innerWidth - size - 8);
    const maxY = Math.max(8, window.innerHeight - size - 8);
    const angle = Math.random() * Math.PI * 2;
    const speed = 104 + Math.random() * 64;

    motion.x = randomBetween(8, maxX);
    motion.y = randomBetween(8, maxY);
    motion.vx = Math.cos(angle) * speed;
    motion.vy = Math.sin(angle) * speed;
  }

  function keepMosquitoInViewport() {
    bounceWithinViewport();
    applyMosquitoPosition();
  }

  function handleMouseMove(event) {
    mousePosition = {
      x: event.clientX,
      y: event.clientY
    };
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopBuzzSound();
      stopFlight();
      return;
    }

    if (state.buzzBusterEnabled && pendingSpawn && !mosquitoElement) {
      showMosquito();
      return;
    }

    if (state.buzzBusterEnabled && mosquitoElement) {
      startBuzzSound();
      startFlight();
    }
  }

  function startBuzzSound() {
    stopBuzzSound();

    const buzzUrl = getAssetUrl(ASSETS.buzz);
    if (!buzzUrl) {
      return;
    }

    try {
      buzzAudio = new Audio(buzzUrl);
      buzzAudio.loop = true;
      buzzAudio.volume = 0.2;
      const playPromise = buzzAudio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    } catch (_error) {
      buzzAudio = null;
    }
  }

  function stopBuzzSound() {
    if (!buzzAudio) {
      return;
    }

    try {
      buzzAudio.pause();
      buzzAudio.currentTime = 0;
    } catch (_error) {
      // Audio can become invalid after extension reload.
    }

    buzzAudio = null;
  }

  function playOneShot(assetPath, volume) {
    const url = getAssetUrl(assetPath);
    if (!url) {
      return;
    }

    try {
      const audio = new Audio(url);
      audio.volume = volume;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    } catch (_error) {
      // Page or extension context may block audio; gameplay continues.
    }
  }

  function handleRacketMissClick(event) {
    if (!racketArmed || !mosquitoElement) {
      return;
    }

    if (mosquitoElement.contains(event.target) || (racketPromptElement && racketPromptElement.contains(event.target))) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    playOneShot(ASSETS.miss, 0.55);
  }

  function incrementKillCount() {
    storageGet({ killedCount: 0 }, (items) => {
      const nextCount = normalizeCount(items.killedCount) + 1;
      state.killedCount = nextCount;
      storageSet({ killedCount: nextCount });
    });
  }

  function showRacketPrompt() {
    removeRacketPrompt();

    const host = getHostElement();
    if (!host) {
      return;
    }

    racketPromptElement = document.createElement("div");
    racketPromptElement.id = IDS.racketPrompt;

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Equip mosquito racket");

    const image = document.createElement("img");
    const racketUrl = getAssetUrl(ASSETS.racketCursor);
    if (!racketUrl) {
      racketPromptElement = null;
      return;
    }
    image.src = racketUrl;
    image.alt = "";

    const label = document.createElement("span");
    label.textContent = "Equip racket";

    button.append(image, label);
    button.addEventListener("click", armRacket);

    racketPromptElement.appendChild(button);
    host.appendChild(racketPromptElement);
  }

  function removeRacketPrompt() {
    if (!racketPromptElement) {
      return;
    }

    racketPromptElement.remove();
    racketPromptElement = null;
  }

  function armRacket(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    racketArmed = true;
    document.documentElement.classList.add(CLASSES.racketArmed);
    removeRacketPrompt();
  }

  function disarmRacket() {
    racketArmed = false;
    document.documentElement.classList.remove(CLASSES.racketArmed);
  }

  function nudgeRacketPrompt() {
    if (!racketPromptElement) {
      showRacketPrompt();
      return;
    }

    racketPromptElement.classList.remove(CLASSES.promptNudge);
    void racketPromptElement.offsetWidth;
    racketPromptElement.classList.add(CLASSES.promptNudge);
  }

  function showSplat(x, y) {
    const host = getHostElement();
    if (!host || !injectStyles()) {
      return;
    }

    const splat = document.createElement("div");
    splat.className = CLASSES.splat;
    splat.textContent = "SPLAT!";
    splat.style.left = `${x}px`;
    splat.style.top = `${y}px`;
    host.appendChild(splat);

    window.setTimeout(() => splat.remove(), 700);
  }

  function injectStyles() {
    if (document.getElementById(IDS.style)) {
      return true;
    }

    const cursorUrl = getAssetUrl(ASSETS.racketCursor);
    if (!cursorUrl) {
      return false;
    }

    try {
      const style = document.createElement("style");
      style.id = IDS.style;
      style.textContent = buildStyles(cursorUrl);
      (document.head || document.documentElement).appendChild(style);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function buildStyles(cursorUrl) {
    return `
      html.${CLASSES.racketArmed},
      html.${CLASSES.racketArmed} * {
        cursor: url("${cursorUrl}") 18 18, crosshair !important;
      }

      #${IDS.mosquito} {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: ${MAX_Z_INDEX} !important;
        display: block !important;
        height: auto !important;
        padding: 0 !important;
        margin: 0 !important;
        border: 0 !important;
        background: transparent !important;
        pointer-events: auto !important;
        user-select: none !important;
        touch-action: manipulation !important;
        will-change: transform !important;
        filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.22)) !important;
      }

      #${IDS.mosquito} img {
        all: initial !important;
        display: block !important;
        width: 100% !important;
        height: auto !important;
        pointer-events: none !important;
        user-select: none !important;
        animation: buzz-buster-jitter 90ms linear infinite alternate !important;
      }

      #${IDS.mosquito}.${CLASSES.mosquitoHit} {
        pointer-events: none !important;
        opacity: 0 !important;
        transform: translate3d(var(--bb-hit-x, 0), var(--bb-hit-y, 0), 0) scale(0.35) rotate(34deg) !important;
        transition: opacity 150ms ease, transform 150ms ease !important;
      }

      #${IDS.racketPrompt} {
        all: initial !important;
        position: fixed !important;
        right: 16px !important;
        bottom: 24px !important;
        z-index: ${MAX_Z_INDEX} !important;
        display: block !important;
        pointer-events: auto !important;
      }

      #${IDS.racketPrompt} button {
        all: initial !important;
        display: flex !important;
        align-items: center !important;
        gap: 9px !important;
        min-width: 152px !important;
        min-height: 52px !important;
        padding: 7px 12px 7px 8px !important;
        border: 1px solid rgba(47, 99, 35, 0.3) !important;
        border-radius: 8px !important;
        background: #ffffff !important;
        color: #1f2a1d !important;
        box-shadow: 0 12px 26px rgba(0, 0, 0, 0.2) !important;
        font: 900 13px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        cursor: pointer !important;
        user-select: none !important;
      }

      #${IDS.racketPrompt} button:hover {
        transform: translateY(-1px) !important;
      }

      #${IDS.racketPrompt} img {
        all: initial !important;
        display: block !important;
        width: 42px !important;
        height: 42px !important;
        object-fit: contain !important;
        pointer-events: none !important;
      }

      #${IDS.racketPrompt} span {
        all: initial !important;
        display: block !important;
        color: #1f2a1d !important;
        font: 900 13px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: none !important;
      }

      #${IDS.racketPrompt}.${CLASSES.promptNudge} button {
        animation: buzz-buster-racket-nudge 360ms ease !important;
      }

      .${CLASSES.splat} {
        all: initial !important;
        position: fixed !important;
        z-index: ${MAX_Z_INDEX} !important;
        transform: translate(-50%, -50%) scale(1) !important;
        padding: 6px 10px !important;
        border: 2px solid #b91c1c !important;
        border-radius: 8px !important;
        background: #fff8f0 !important;
        color: #b91c1c !important;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.24) !important;
        font: 900 18px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: none !important;
        animation: buzz-buster-splat-pop 700ms ease forwards !important;
      }

      @keyframes buzz-buster-jitter {
        from { transform: translateY(-1px) rotate(-2deg); }
        to { transform: translateY(1px) rotate(2deg); }
      }

      @keyframes buzz-buster-splat-pop {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.55) rotate(-8deg); }
        15% { opacity: 1; transform: translate(-50%, -50%) scale(1.08) rotate(4deg); }
        100% { opacity: 0; transform: translate(-50%, -84%) scale(0.92) rotate(0deg); }
      }

      @keyframes buzz-buster-racket-nudge {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-6px); }
        40% { transform: translateX(6px); }
        60% { transform: translateX(-4px); }
        80% { transform: translateX(4px); }
      }
    `;
  }

  function removeStyles() {
    const style = document.getElementById(IDS.style);
    if (style) {
      style.remove();
    }
  }

  function getAssetUrl(assetPath) {
    try {
      if (!chrome || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
        cleanup();
        return "";
      }

      return chrome.runtime.getURL(assetPath);
    } catch (_error) {
      cleanup();
      return "";
    }
  }

  function storageGet(defaults, callback) {
    try {
      chrome.storage.local.get(defaults, (items) => {
        let lastError = null;
        try {
          lastError = chrome.runtime.lastError;
        } catch (_error) {
          cleanup();
          return;
        }

        if (lastError || destroyed) {
          return;
        }

        callback(items);
      });
    } catch (_error) {
      cleanup();
    }
  }

  function storageSet(values) {
    try {
      chrome.storage.local.set(values, () => {
        try {
          void chrome.runtime.lastError;
        } catch (_error) {
          cleanup();
        }
      });
    } catch (_error) {
      cleanup();
    }
  }

  function addChromeListener(register) {
    try {
      register();
    } catch (_error) {
      cleanup();
    }
  }

  function getHostElement() {
    return document.body || document.documentElement;
  }

  function clearMosquitoTimer() {
    if (!mosquitoTimer) {
      return;
    }

    window.clearTimeout(mosquitoTimer);
    mosquitoTimer = null;
  }

  function getRandomDelayMs() {
    const min = state.minDelay * 1000;
    const max = state.maxDelay * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function getMosquitoSize() {
    const viewportBased = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.075);
    return Math.min(70, Math.max(44, viewportBased));
  }

  function getCurrentMosquitoSize() {
    if (!mosquitoElement) {
      return getMosquitoSize();
    }

    return mosquitoElement.getBoundingClientRect().width || getMosquitoSize();
  }

  function normalizeSettings(input) {
    const minDelay = clampInteger(input.minDelay, DEFAULT_SETTINGS.minDelay, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS - 1);
    const maxDelay = clampInteger(input.maxDelay, DEFAULT_SETTINGS.maxDelay, minDelay + 1, MAX_DELAY_SECONDS);

    return {
      buzzBusterEnabled: Boolean(input.buzzBusterEnabled),
      minDelay,
      maxDelay,
      killedCount: normalizeCount(input.killedCount)
    };
  }

  function normalizeCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(parsed)));
  }

  function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
  }

  function getPublicState() {
    return {
      buzzBusterEnabled: state.buzzBusterEnabled,
      minDelay: state.minDelay,
      maxDelay: state.maxDelay,
      killedCount: state.killedCount,
      mosquitoVisible: Boolean(mosquitoElement),
      racketArmed
    };
  }

  function cleanup() {
    if (destroyed) {
      return;
    }

    destroyed = true;
    pendingSpawn = false;
    clearMosquitoTimer();
    removeMosquito();
    removeRacketPrompt();
    removeStyles();
    disarmRacket();
    document.removeEventListener("visibilitychange", handleVisibilityChange);

    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      chrome.storage.onChanged.removeListener(handleStorageChange);
    } catch (_error) {
      // The extension context may already be invalid.
    }

    window[CLEANUP_KEY] = null;
  }
})();
