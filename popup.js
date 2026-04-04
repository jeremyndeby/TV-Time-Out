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

const STEP_PCT = { 1: 15, 2: 40, 3: 100 };

function showProgress(stepIndex = 0, fetchCount = "") {
  progressWrap.classList.add("visible");
  const pct = STEP_PCT[stepIndex] ?? 0;
  currentProgress = pct;
  progressBar.style.width = pct + "%";
  if (fetchCount) fetchCountEl.textContent = fetchCount;
}

function hideProgress() {
  progressWrap.classList.remove("visible");
  progressBar.style.width = "0%";
  currentProgress = 0;
}

function startTimer() {
  stopTimer();
  startTime = Date.now();
  elapsedEl.textContent = "0s elapsed";
  elapsedInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    elapsedEl.textContent = `${elapsed}s elapsed`;
  }, 1000);
}

function stopTimer() {
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  startTime = null;
}

function resetToIdle() {
  btnExport.disabled = false;
  hideProgress();
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
    chrome.tabs.query({ url: "https://app.tvtime.com/*" }, (tabs) => {
      if (!tabs?.length) { resolve(null); return; }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const token = (localStorage.getItem("flutter.jwtToken") || "").replace(/^"|"$/g, "");
          const raw   = localStorage.getItem("flutter.user") || "";
          let userId  = null;
          const m = raw.match(/:(\d{4,})/);
          if (m) userId = m[1];
          return { token: token || null, userId };
        }
      }, (results) => {
        if (chrome.runtime.lastError) {
          console.warn("[TVTO POPUP] executeScript error:", chrome.runtime.lastError.message);
          resolve(null); return;
        }
        const result = results?.[0]?.result;
        console.log("[TVTO POPUP] executeScript result:", JSON.stringify(result));
        if (!result?.token) { resolve(null); return; }
        resolve(result);
      });
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

  const r      = state?.result ?? {};
  const shows  = r.shows?.length  ?? 0;
  const movies = r.movies?.length ?? 0;

  const parts = [];
  if (shows)  parts.push(`${shows} shows`);
  if (movies) parts.push(`${movies} movies`);

  setStatus(`✓ ${parts.join(" · ")} exported. Downloading files…`, "success");
  btnExport.disabled = false;

  // Auto-download — no user click required
  try {
    downloadAll(r);
    // Update message after downloads are queued
    setTimeout(() => {
      setStatus(`🎉 Great success! Export complete & files saved.`, "success");
    }, [shows, movies].filter(Boolean).length * 600 + 200);
  } catch (e) {
    setStatus(`Export done but download failed: ${e.message}`, "error");
  }
}

function handleExportState(state) {
  switch (state.status) {
    case "running":
      showProgress(state.stepIndex, state.fetchCount);
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
  const credentials = await ensureCredentials();

  if (!credentials?.token || !credentials?.userId) {
    setStatus("Please log in to app.tvtime.com first.", "info");
    btnExport.disabled = false;
    return;
  }

  const state = await sendMsg({ type: "EXPORT_PROGRESS" });

  if (state.status === "running") {
    setStatus(state.step || "Fetching your data…", "running", true);
    btnExport.disabled = true;
    startTimer();
    startPolling();
    return;
  }

  if (state.status === "done" && state.count > 0) {
    handleExportDone(state);
    return;
  }

  setStatus("Connected · Ready to export.", "info");
  btnExport.disabled = false;
}

// ---------------------------------------------------------------------------
// Export button
// ---------------------------------------------------------------------------
btnExport.addEventListener("click", async () => {
  const credentials = await ensureCredentials();

  if (!credentials?.token) {
    setStatus("Please log in to app.tvtime.com first.", "error");
    return;
  }

  await sendMsg({ type: "RESET_EXPORT" });

  console.log("[TVTO POPUP] credentials before START_EXPORT:", JSON.stringify(credentials));
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
  startTimer();
  startPolling();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();
