/**
 * popup.js — TV Time Out
 *
 * Orchestrates the popup UI:
 *  1. Checks credentials on load (via background.js)
 *  2. Starts export on button click
 *  3. Polls background for step progress
 *  4. Auto-downloads all files when export completes
 */

import { downloadAll } from "./exporter.js";

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const statusBar    = document.getElementById("status-bar");
const statusText   = document.getElementById("status-text");
const progressWrap  = document.getElementById("progress-wrap");
const progressBar   = document.getElementById("progress-bar");
const fetchCountEl  = document.getElementById("fetch-count");
const elapsedEl     = document.getElementById("elapsed-time");
const btnExport     = document.getElementById("btn-export");
const warningBar       = document.getElementById("warning-bar");
const warningBarMovies = document.getElementById("warning-bar-movies");
const formatSelect     = document.getElementById("format-select");

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------
let pollTimer       = null;
let elapsedInterval = null;
let startTime       = null;
let currentProgress = 0;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(text, type = "info", showSpinner = false) {
  statusBar.className = type;
  statusText.innerHTML = showSpinner
    ? `<span class="spinner"></span> ${text}`
    : text;
}

const STEP_PCT = { 1: 10, 2: 30, 3: 30 };

function showProgress(stepIndex = 0, fetchCount = "", pct = null) {
  progressWrap.classList.add("visible");
  const computedPct = pct !== null ? pct : (STEP_PCT[stepIndex] ?? 0);
  currentProgress = computedPct;
  progressBar.style.width = computedPct + "%";
  if (fetchCount) fetchCountEl.textContent = fetchCount;
}

function hideProgress() {
  progressWrap.classList.remove("visible");
  progressBar.style.width = "0%";
  currentProgress = 0;
}

function startElapsedInterval() {
  elapsedInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    elapsedEl.textContent = `${elapsed}s elapsed`;
  }, 1000);
}

function startTimer() {
  stopTimer(false);
  startTime = Date.now();
  elapsedEl.textContent = "0s elapsed";
  startElapsedInterval();
}

function stopTimer(clearStorage = true) {
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  startTime = null;
  if (clearStorage) chrome.storage.local.remove("exportStartTime");
}

function resetToIdle() {
  btnExport.disabled = false;
  hideProgress();
}

function setDisconnectedUI() {
  [btnExport, formatSelect].forEach(el => {
    if (!el) return;
    el.style.opacity       = "0.4";
    el.style.pointerEvents = "none";
    el.style.cursor        = "not-allowed";
  });
}

function clearDisconnectedUI() {
  [btnExport, formatSelect].forEach(el => {
    if (!el) return;
    el.style.opacity       = "";
    el.style.pointerEvents = "";
    el.style.cursor        = "";
  });
}

// ---------------------------------------------------------------------------
// Background messaging
// ---------------------------------------------------------------------------
function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? {});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Credential resolution — reads directly from the TV Time tab via executeScript
// if the background service worker woke up after the initial page load.
// ---------------------------------------------------------------------------
async function getCredentialsFromTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "https://app.tvtime.com/*" }, async (tabs) => {
      if (!tabs?.length) { resolve(null); return; }

      // Filter to tabs that are fully loaded and not discarded/suspended.
      // executeScript fails silently on discarded or still-loading tabs even
      // when the URL matches host_permissions, producing the misleading
      // "Extension manifest must request permission" error.
      const scriptableTabs = tabs.filter(t =>
        t.status === "complete" && !t.discarded && t.url?.startsWith("https://app.tvtime.com/")
      );

      // Fallback: if nothing passes the filter, try all tabs anyway (user may
      // be on a loading tab — better to attempt than to silently return null).
      const candidates = scriptableTabs.length ? scriptableTabs : tabs;

      const readFunc = () => {
        const rawToken = localStorage.getItem("flutter.jwtToken");
        const token = rawToken ? rawToken.replace(/^"|"$/g, "") : null;
        const rawUser = localStorage.getItem('flutter.user');
        let userId = null;
        // Tentative 1 : JSON.parse direct
        try { userId = JSON.parse(rawUser)?.id; } catch(e) {}
        // Tentative 2 : regex sur la string brute
        if (!userId && rawUser) {
          const m = rawUser.match(/"id"\s*:\s*"?(\d+)"?/);
          if (m) userId = m[1];
        }
        // Tentative 3 : extraire depuis le JWT token lui-même
        if (!userId && token) {
          try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            userId = payload.id || payload.sub;
          } catch(e) {}
        }
        // Tentative 4 : URL fallback (ancien comportement)
        if (!userId) {
          const match = window.location.href.match(/:(\d{4,})/);
          userId = match ? match[1] : null;
        }
        return { token, userId };
      };

      // Try each candidate tab in order; return on first success.
      for (const tab of candidates) {
        const result = await new Promise((res) => {
          chrome.scripting.executeScript(
            { target: { tabId: tab.id }, world: "MAIN", func: readFunc },
            (results) => {
              if (chrome.runtime.lastError) {
                console.warn("[TVTO] executeScript skipped tab", tab.id, "—", chrome.runtime.lastError.message);
                res(null); return;
              }
              const r = results?.[0]?.result;
              res(r?.token ? r : null);
            }
          );
        });
        if (result) { resolve(result); return; }
      }

      resolve(null);
    });
  });
}

async function ensureCredentials() {
  const { credentials } = await sendMsg({ type: "GET_CREDENTIALS" });
  if (credentials?.token && credentials?.userId) return credentials;

  const fresh = await getCredentialsFromTab();
  if (!fresh) return null;

  await sendMsg({ type: "CREDENTIALS_FROM_PAGE", ...fresh });
  return fresh;
}

// ---------------------------------------------------------------------------
// Export state handler
// ---------------------------------------------------------------------------
function handleExportDone(state) {
  stopPolling();
  stopTimer();
  hideProgress();

  const r            = state?.result ?? {};
  const shows        = r.shows?.length        ?? 0;
  const episodes     = r.watchedEpisodes      ?? 0;
  const movies       = r.movies?.length       ?? 0;
  const lists        = r.lists?.length        ?? 0;
  const failed       = r.failedShows?.length  ?? 0;
  const failedMovies = r.failedMovies?.length ?? 0;

  const parts = [];
  if (shows)  parts.push(`${shows} shows`);
  if (movies) parts.push(`${movies} movies`);
  if (lists)  parts.push(`${lists} lists`);

  setStatus(`✓ ${parts.join(" · ")} exported. Downloading files…`, "success");
  btnExport.disabled = false;

  // Warning bar séries — affiché seulement si des séries ont échoué
  if (failed > 0) {
    warningBar.textContent = `⚠️ ${failed} series missing seasons (server timeout) — see report file`;
    warningBar.classList.add("visible");
  } else {
    warningBar.classList.remove("visible");
  }

  // Warning bar films — affiché seulement si des films ont un titre null
  if (failedMovies > 0) {
    warningBarMovies.textContent = `⚠️ ${failedMovies} movies could not be exported — see report file`;
    warningBarMovies.classList.add("visible");
  } else {
    warningBarMovies.classList.remove("visible");
  }

  // Auto-download — no user click required
  try {
    const format = formatSelect?.value ?? "json";
    downloadAll(r, format);
    // Update message after downloads are queued
    const fileCount = [shows, movies, lists].filter(Boolean).length + (failed > 0 ? 1 : 0) + (failedMovies > 0 ? 1 : 0);
    const durationS = r.durationMs ? Math.round(r.durationMs / 1000) : null;
    const formatLabel = format === "both" ? "JSON+CSV" : format.toUpperCase();
    const parts = [];
    if (durationS !== null) parts.push(`${durationS}s`);
    parts.push(formatLabel);
    if (shows)  parts.push(`${shows} shows & ${episodes.toLocaleString()} eps 📺`);
    if (movies) parts.push(`${movies} movies 📽️`);
    if (lists)  parts.push(`${lists} lists 📋`);
    const summaryStr = parts.length ? ` (${parts.join(" · ")})` : "";
    setTimeout(() => {
      setStatus(`🎉 Great success! Export complete & files saved.${summaryStr}`, "success");
      // Clear the export state so reopening the popup returns to "Ready to export."
      // without re-triggering downloads.
      sendMsg({ type: "RESET_EXPORT" });
    }, fileCount * 600 + 200);
  } catch (e) {
    setStatus(`Export done but download failed: ${e.message}`, "error");
  }
}

function handleExportState(state) {
  switch (state.status) {
    case "running":
      showProgress(state.stepIndex, state.fetchCount, state.pct ?? null);
      setStatus(state.step || "Fetching your data…", "running", true);
      btnExport.disabled = true;
      break;

    case "done":
      handleExportDone(state);
      break;

    case "error":
      stopPolling();
      stopTimer();
      resetToIdle();
      setStatus(`Error: ${state.error}`, "error");
      break;

    default:
      stopPolling();
      break;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const state = await sendMsg({ type: "EXPORT_PROGRESS" });
    handleExportState(state);
  }, 600);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Init — check credentials and restore any in-progress / completed export
// ---------------------------------------------------------------------------
async function init() {
  document.getElementById('version-label').textContent =
    'v' + chrome.runtime.getManifest().version;

  // Restore previously saved export format
  chrome.storage.local.get("exportFormat", (data) => {
    if (data.exportFormat) formatSelect.value = data.exportFormat;
  });

  const credentials = await ensureCredentials();

  if (!credentials?.token || !credentials?.userId) {
    setStatus(`Please log in at <a href="https://app.tvtime.com" target="_blank" style="color: #f5c518;">app.tvtime.com</a> to get started.`, "error");
    btnExport.disabled = false;
    setDisconnectedUI();
    return;
  }

  clearDisconnectedUI();
  const state = await sendMsg({ type: "EXPORT_PROGRESS" });

  if (state.status === "running") {
    setStatus(state.step || "Fetching your data...", "running", true);
    btnExport.disabled = true;
    chrome.storage.local.get(["exportStartTime"], (data) => {
      stopTimer(false);
      if (data.exportStartTime) {
        startTime = data.exportStartTime;
      } else {
        startTime = Date.now();
      }
      startElapsedInterval();
      startPolling();
    });
    return;
  }

  if (state.status === "done" && state.count > 0) {
    handleExportDone(state);
    return;
  }

  setStatus("Connected · Ready to export.", "success");
  btnExport.disabled = false;
}

// ---------------------------------------------------------------------------
// Export button
// ---------------------------------------------------------------------------
btnExport.addEventListener("click", async () => {
  const credentials = await ensureCredentials();

  if (!credentials?.token) {
    setStatus(`Please log in at <a href="https://app.tvtime.com" target="_blank" style="color: #f5c518;">app.tvtime.com</a> to get started.`, "error");
    return;
  }

  await sendMsg({ type: "RESET_EXPORT" });

  const resp = await sendMsg({
    type:   "START_EXPORT",
    token:  credentials.token,
    userId: credentials.userId
  });

  if (!resp.ok) {
    setStatus(`Could not start export: ${resp.error}`, "error");
    return;
  }

  setStatus("Starting export…", "running", true);
  btnExport.disabled = true;
  showProgress();
  chrome.storage.local.set({ exportStartTime: Date.now() });
  startTimer();
  startPolling();
});

// ---------------------------------------------------------------------------
// Format selector — persist choice across popup sessions
// ---------------------------------------------------------------------------
formatSelect.addEventListener("change", () => {
  chrome.storage.local.set({ exportFormat: formatSelect.value });
});

// ---------------------------------------------------------------------------
// Boot — DOMContentLoaded garantit que tous les éléments sont disponibles
// avant que init() tente de les styler.
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", init);
