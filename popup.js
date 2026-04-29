const DEFAULT_SETTINGS = {
  buzzBusterEnabled: false,
  minDelay: 30,
  maxDelay: 120,
  killedCount: 0
};

const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 7200;

const elements = {};

document.addEventListener("DOMContentLoaded", initPopup);

function initPopup() {
  elements.form = document.getElementById("settingsForm");
  elements.minDelay = document.getElementById("minDelay");
  elements.maxDelay = document.getElementById("maxDelay");
  elements.startButton = document.getElementById("startButton");
  elements.stopButton = document.getElementById("stopButton");
  elements.killedCount = document.getElementById("killedCount");
  elements.message = document.getElementById("message");
  elements.modeStatus = document.getElementById("modeStatus");

  elements.form.addEventListener("submit", handleStart);
  elements.stopButton.addEventListener("click", handleStop);

  chrome.storage.onChanged.addListener(handleStorageChange);
  hydratePopup();
}

async function hydratePopup() {
  try {
    const settings = await getSettings();
    elements.minDelay.value = settings.minDelay;
    elements.maxDelay.value = settings.maxDelay;
    elements.killedCount.textContent = settings.killedCount;
    renderModeStatus(settings.buzzBusterEnabled);
  } catch (_error) {
    elements.minDelay.value = DEFAULT_SETTINGS.minDelay;
    elements.maxDelay.value = DEFAULT_SETTINGS.maxDelay;
    elements.killedCount.textContent = DEFAULT_SETTINGS.killedCount;
    renderModeStatus(false, "warning");
    setMessage("Could not load saved settings.", "warning");
  }
}

async function handleStart(event) {
  event.preventDefault();
  clearMessage();

  const validation = readAndValidateDelay();
  if (!validation.ok) {
    setMessage(validation.message, "warning");
    return;
  }

  setBusy(true);

  try {
    const nextSettings = {
      buzzBusterEnabled: true,
      minDelay: validation.minDelay,
      maxDelay: validation.maxDelay
    };

    await chromeStorageSet(nextSettings);
    renderModeStatus(true);

    const result = await notifyActiveTab("START_BUZZ_BUSTER_MODE", nextSettings);
    if (!result.ok) {
      setMessage("Saved. Open or reload a normal web page if this tab blocks scripts.", "warning");
      renderModeStatus(true, "warning");
      return;
    }

    setMessage("Buzz-Buster Mode is running.");
  } catch (_error) {
    setMessage("Could not start Buzz-Buster Mode.", "warning");
  } finally {
    setBusy(false);
  }
}

async function handleStop() {
  clearMessage();
  setBusy(true);

  try {
    await chromeStorageSet({ buzzBusterEnabled: false });
    renderModeStatus(false);

    const result = await notifyActiveTab("STOP_BUZZ_BUSTER_MODE");
    if (!result.ok) {
      setMessage("Stopped globally. This tab may not allow extension scripts.", "warning");
      return;
    }

    setMessage("Buzz-Buster Mode stopped.");
  } catch (_error) {
    setMessage("Could not stop Buzz-Buster Mode.", "warning");
  } finally {
    setBusy(false);
  }
}

function readAndValidateDelay() {
  const minDelay = Number(elements.minDelay.value);
  const maxDelay = Number(elements.maxDelay.value);

  if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay)) {
    return { ok: false, message: "Min and max delay must be numbers." };
  }

  if (!Number.isInteger(minDelay) || !Number.isInteger(maxDelay)) {
    return { ok: false, message: "Delay values must be whole seconds." };
  }

  if (minDelay < MIN_DELAY_SECONDS) {
    return { ok: false, message: "Min delay must be at least 5 seconds." };
  }

  if (maxDelay <= minDelay) {
    return { ok: false, message: "Max delay must be greater than min delay." };
  }

  if (maxDelay > MAX_DELAY_SECONDS) {
    return { ok: false, message: "Max delay cannot exceed 7200 seconds." };
  }

  return { ok: true, minDelay, maxDelay };
}

function handleStorageChange(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (changes.buzzBusterEnabled) {
    renderModeStatus(Boolean(changes.buzzBusterEnabled.newValue));
  }

  if (changes.killedCount) {
    elements.killedCount.textContent = String(normalizeCount(changes.killedCount.newValue));
  }

  if (changes.minDelay) {
    elements.minDelay.value = normalizeDelay(changes.minDelay.newValue, DEFAULT_SETTINGS.minDelay);
  }

  if (changes.maxDelay) {
    elements.maxDelay.value = normalizeDelay(changes.maxDelay.newValue, DEFAULT_SETTINGS.maxDelay);
  }
}

async function notifyActiveTab(type, payload = {}) {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !/^https?:|^file:/.test(tab.url || "")) {
    return { ok: false, error: "Unsupported tab." };
  }

  try {
    return await sendTabMessage(tab.id, { type, payload });
  } catch (firstError) {
    try {
      await injectContentScript(tab.id);
      return await sendTabMessage(tab.id, { type, payload });
    } catch (secondError) {
      return { ok: false, error: secondError.message || firstError.message };
    }
  }
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response || { ok: true });
    });
  });
}

function injectContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve({
        buzzBusterEnabled: Boolean(items.buzzBusterEnabled),
        minDelay: normalizeDelay(items.minDelay, DEFAULT_SETTINGS.minDelay),
        maxDelay: normalizeDelay(items.maxDelay, DEFAULT_SETTINGS.maxDelay),
        killedCount: normalizeCount(items.killedCount)
      });
    });
  });
}

function chromeStorageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function normalizeDelay(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function renderModeStatus(enabled, tone) {
  elements.modeStatus.textContent = enabled ? "Running" : "Stopped";
  elements.modeStatus.className = `status ${enabled ? "status--running" : "status--idle"}`;

  if (tone === "warning") {
    elements.modeStatus.className = "status status--warning";
  }
}

function setMessage(message, tone) {
  elements.message.textContent = message;
  elements.message.dataset.tone = tone || "info";
}

function clearMessage() {
  elements.message.textContent = "";
  delete elements.message.dataset.tone;
}

function setBusy(isBusy) {
  elements.startButton.disabled = isBusy;
  elements.stopButton.disabled = isBusy;
}
