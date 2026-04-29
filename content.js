(() => {
  if (typeof window.__buzzBusterCleanup === "function") {
    try {
      window.__buzzBusterCleanup();
    } catch (_error) {
      // A stale content-script context can fail cleanup after extension reload.
    }
  }

  const DEFAULT_SETTINGS = {
    buzzBusterEnabled: false,
    minDelay: 30,
    maxDelay: 120,
    killedCount: 0
  };

  const MAX_Z_INDEX = 2147483647;
  const MIN_DELAY_SECONDS = 5;
  const MAX_DELAY_SECONDS = 7200;
  const STYLE_ID = "buzz-buster-style";
  const MOSQUITO_ID = "buzz-buster-mosquito";
  const RACKET_PROMPT_ID = "buzz-buster-racket-prompt";

  let state = { ...DEFAULT_SETTINGS };
  let mosquitoTimer = null;
  let mosquitoElement = null;
  let animationFrame = null;
  let buzzAudio = null;
  let lastFrameTime = 0;
  let mousePosition = null;
  let pendingSpawn = false;
  let racketArmed = false;
  let racketPromptElement = null;

  const motion = {
    x: 0,
    y: 0,
    vx: 120,
    vy: 90
  };

  window.__buzzBusterCleanup = cleanup;
  init();

  function init() {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    chrome.storage.onChanged.addListener(handleStorageChange);

    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
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

    if (!state.buzzBusterEnabled || mosquitoElement) {
      return;
    }

    mosquitoTimer = window.setTimeout(showMosquito, getRandomDelayMs());
  }

  function showMosquito() {
    clearMosquitoTimer();

    if (!state.buzzBusterEnabled || mosquitoElement) {
      pendingSpawn = false;
      return;
    }

    if (document.hidden) {
      pendingSpawn = true;
      return;
    }

    injectStyles();
    showRacketPrompt();
    disarmRacket();
    pendingSpawn = false;

    const wrapper = document.createElement("div");
    wrapper.id = MOSQUITO_ID;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "Swat mosquito");
    wrapper.tabIndex = 0;

    const image = document.createElement("img");
    image.src = chrome.runtime.getURL("assets/mosquito.png");
    image.alt = "";
    image.draggable = false;
    wrapper.appendChild(image);

    wrapper.addEventListener("click", killMosquito);
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        killMosquito(event);
      }
    });

    const size = getMosquitoSize();
    wrapper.style.setProperty("width", `${size}px`, "important");
    mosquitoElement = wrapper;
    getHostElement().appendChild(wrapper);

    resetMotion(size);
    applyMosquitoPosition();
    startBuzzSound();
    startFlight();
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("resize", keepMosquitoInViewport, { passive: true });
    document.addEventListener("click", handleRacketMissClick, true);
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

    const rect = mosquitoElement.getBoundingClientRect();
    const splatX = rect.left + rect.width / 2;
    const splatY = rect.top + rect.height / 2;
    const deadElement = mosquitoElement;

    mosquitoElement = null;
    stopFlight();
    stopBuzzSound();
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("resize", keepMosquitoInViewport);
    document.removeEventListener("click", handleRacketMissClick, true);
    removeRacketPrompt();
    disarmRacket();
    playHitSound();
    showSplat(splatX, splatY);
    incrementKillCount();

    deadElement.style.setProperty("--ms-hit-x", `${motion.x}px`);
    deadElement.style.setProperty("--ms-hit-y", `${motion.y}px`);
    deadElement.classList.add("buzz-buster-hit");
    window.setTimeout(() => deadElement.remove(), 170);

    scheduleNextMosquito();
  }

  function removeMosquito() {
    stopFlight();
    stopBuzzSound();
    removeRacketPrompt();
    disarmRacket();
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("resize", keepMosquitoInViewport);
    document.removeEventListener("click", handleRacketMissClick, true);

    if (mosquitoElement) {
      mosquitoElement.remove();
      mosquitoElement = null;
    }
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

    const size = mosquitoElement.getBoundingClientRect().width || getMosquitoSize();
    const centerX = motion.x + size / 2;
    const centerY = motion.y + size / 2;
    const dx = centerX - mousePosition.x;
    const dy = centerY - mousePosition.y;
    const distance = Math.hypot(dx, dy);
    const repelRadius = 160;

    if (distance <= 0 || distance > repelRadius) {
      return;
    }

    const force = ((repelRadius - distance) / repelRadius) * 380;
    motion.vx += (dx / distance) * force * delta;
    motion.vy += (dy / distance) * force * delta;
  }

  function addRandomDrift(delta) {
    motion.vx += (Math.random() - 0.5) * 90 * delta;
    motion.vy += (Math.random() - 0.5) * 90 * delta;
  }

  function clampVelocity() {
    const speed = Math.hypot(motion.vx, motion.vy);
    const minSpeed = 82;
    const maxSpeed = 230;

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

    const size = mosquitoElement.getBoundingClientRect().width || getMosquitoSize();
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
    const wiggle = Math.sin(timestamp / 60) * 5;
    mosquitoElement.style.transform = `translate3d(${motion.x}px, ${motion.y}px, 0) scaleX(${flip}) rotate(${wiggle}deg)`;
  }

  function resetMotion(size) {
    const maxX = Math.max(8, window.innerWidth - size - 8);
    const maxY = Math.max(8, window.innerHeight - size - 8);
    const angle = Math.random() * Math.PI * 2;
    const speed = 110 + Math.random() * 70;

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

    buzzAudio = new Audio(chrome.runtime.getURL("assets/mosquito-buzz.mp3"));
    buzzAudio.loop = true;
    buzzAudio.volume = 0.22;

    const playPromise = buzzAudio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  function stopBuzzSound() {
    if (!buzzAudio) {
      return;
    }

    buzzAudio.pause();
    buzzAudio.currentTime = 0;
    buzzAudio = null;
  }

  function playMissSound() {
    const audio = new Audio(chrome.runtime.getURL("assets/slap.mp3"));
    audio.volume = 0.55;

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  function playHitSound() {
    const audio = new Audio(chrome.runtime.getURL("assets/slap-ahh.mp3"));
    audio.volume = 0.62;

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
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
    playMissSound();
  }

  function incrementKillCount() {
    state.killedCount += 1;
    chrome.storage.local.set({ killedCount: state.killedCount });
  }

  function showRacketPrompt() {
    removeRacketPrompt();

    racketPromptElement = document.createElement("div");
    racketPromptElement.id = RACKET_PROMPT_ID;

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Equip mosquito racket");
    button.innerHTML = `
      <img src="${chrome.runtime.getURL("assets/racket-cursor.png")}" alt="">
      <span>Equip racket</span>
    `;
    button.addEventListener("click", armRacket);

    racketPromptElement.appendChild(button);
    getHostElement().appendChild(racketPromptElement);
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
    document.documentElement.classList.add("buzz-buster-racket-armed");
    removeRacketPrompt();
  }

  function disarmRacket() {
    racketArmed = false;
    document.documentElement.classList.remove("buzz-buster-racket-armed");
  }

  function nudgeRacketPrompt() {
    if (!racketPromptElement) {
      showRacketPrompt();
      return;
    }

    racketPromptElement.classList.remove("buzz-buster-racket-prompt--nudge");
    void racketPromptElement.offsetWidth;
    racketPromptElement.classList.add("buzz-buster-racket-prompt--nudge");
  }

  function showSplat(x, y) {
    injectStyles();
    const splat = document.createElement("div");
    splat.className = "buzz-buster-splat";
    splat.textContent = "SPLAT!";
    splat.style.left = `${x}px`;
    splat.style.top = `${y}px`;
    getHostElement().appendChild(splat);

    window.setTimeout(() => splat.remove(), 700);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const cursorUrl = chrome.runtime.getURL("assets/racket-cursor.png");
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html.buzz-buster-racket-armed,
      html.buzz-buster-racket-armed * {
        cursor: url("${cursorUrl}") 18 18, crosshair !important;
      }

      #${MOSQUITO_ID} {
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

      #${MOSQUITO_ID} img {
        all: initial !important;
        display: block !important;
        width: 100% !important;
        height: auto !important;
        pointer-events: none !important;
        user-select: none !important;
        animation: buzz-buster-jitter 90ms linear infinite alternate !important;
      }

      #${MOSQUITO_ID}.buzz-buster-hit {
        pointer-events: none !important;
        opacity: 0 !important;
        transform: translate3d(var(--ms-hit-x, 0), var(--ms-hit-y, 0), 0) scale(0.35) rotate(34deg) !important;
        transition: opacity 150ms ease, transform 150ms ease !important;
      }

      #${RACKET_PROMPT_ID} {
        all: initial !important;
        position: fixed !important;
        right: 16px !important;
        bottom: 72px !important;
        z-index: ${MAX_Z_INDEX} !important;
        display: block !important;
        pointer-events: auto !important;
      }

      #${RACKET_PROMPT_ID} button {
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

      #${RACKET_PROMPT_ID} button:hover {
        transform: translateY(-1px) !important;
      }

      #${RACKET_PROMPT_ID} img {
        all: initial !important;
        display: block !important;
        width: 42px !important;
        height: 42px !important;
        object-fit: contain !important;
        pointer-events: none !important;
      }

      #${RACKET_PROMPT_ID} span {
        all: initial !important;
        display: block !important;
        color: #1f2a1d !important;
        font: 900 13px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        pointer-events: none !important;
      }

      #${RACKET_PROMPT_ID}.buzz-buster-racket-prompt--nudge button {
        animation: buzz-buster-racket-nudge 360ms ease !important;
      }

      .buzz-buster-splat {
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

    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyles() {
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
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

  function normalizeSettings(input) {
    const minDelay = clampInteger(input.minDelay, DEFAULT_SETTINGS.minDelay, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS - 1);
    const maxDelay = clampInteger(input.maxDelay, DEFAULT_SETTINGS.maxDelay, minDelay + 1, MAX_DELAY_SECONDS);
    const killedCount = Math.max(0, Math.floor(Number(input.killedCount) || 0));

    return {
      buzzBusterEnabled: Boolean(input.buzzBusterEnabled),
      minDelay,
      maxDelay,
      killedCount
    };
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
    pendingSpawn = false;
    clearMosquitoTimer();
    removeMosquito();
    removeRacketPrompt();
    removeStyles();
    disarmRacket();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    chrome.storage.onChanged.removeListener(handleStorageChange);
    window.__buzzBusterCleanup = null;
  }
})();
