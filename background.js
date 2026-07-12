/**
 * background.js — TV Time Out (Service Worker MV3)
 *
 * Rôle :
 *  - Relais entre content.js (qui lit le localStorage TV Time) et popup.js
 *  - Lance l'export complet
 *  - Met en cache les credentials pour éviter d'aller les chercher à chaque fois
 *
 * Messages entrants :
 *   { type: "CREDENTIALS_FROM_PAGE", userId, token }  → envoyé par content.js
 *   { type: "GET_CREDENTIALS" }                        → demandé par popup.js
 *   { type: "START_EXPORT" }                           → déclenché par popup.js
 *   { type: "EXPORT_PROGRESS" }                        → polling depuis popup.js
 */

import { buildSummaryHtml, buildFilesList } from './exporter.js';
import { buildMovieWatchedMap, resolveMovieWatchState } from './apiClient.js';

// JSZip is a UMD bundle. The manifest declares this service worker as
// "type": "module", which makes importScripts() unavailable — module workers
// require ES imports. Loading jszip.min.js as a side-effect ES import still
// runs the UMD wrapper, whose fallback branch does `self.JSZip = factory()`
// because `self` is defined in a service worker but `exports`/`define`/
// `window` are not. The end result is the same as importScripts: after this
// import completes, `self.JSZip` is the JSZip constructor.
import './jszip.min.js';

// ---------------------------------------------------------------------------
// État interne du service worker
// ---------------------------------------------------------------------------
let cachedCredentials = null; // { userId, token }
let exportCancelled   = false; // flipped by CANCEL_EXPORT; checked at every major pipeline step
const CANCEL_SENTINEL = "__TVTO_CANCELLED__"; // error message used to unwind runExport on cancel
let exportState = {
  status:     "idle",   // "idle" | "running" | "done" | "error"
  step:       null,     // texte affiché dans le popup pendant "running"
  stepIndex:  0,        // 1 | 2 | 3 | 4 — pour la barre de progression
  fetchCount: "",       // ex: "676 shows · 28 movies fetched"
  loaded:     0,
  total:      null,
  result:     null,     // { shows, movies, lists } quand done
  error:      null,
  format:     "json",   // "json" | "csv" | "both" — passed from popup at START_EXPORT
  zipBundle:  false,    // true → bundle all outputs into a single .zip download
  errors:     []        // human-readable log lines surfaced in the popup (see recordExportError)
};

// ---------------------------------------------------------------------------
// Export error log — collected during a run and surfaced in the popup so users
// (and Discord support) can see what went wrong without opening the service
// worker console. Every entry is also mirrored to console.error with the
// [TVTO] prefix. Reset at the start of each export (runExport).
// ---------------------------------------------------------------------------
let exportErrors = [];
const MAX_EXPORT_ERRORS = 200; // cap so a pathological run can't grow unbounded

function recordExportError(msg) {
  const ts   = new Date().toISOString().substring(11, 19); // HH:MM:SS
  const line = `[${ts}] ${msg}`;
  exportErrors.push(line);
  if (exportErrors.length > MAX_EXPORT_ERRORS) exportErrors.shift();
  console.error("[TVTO]", msg);
}

// Translate an HTTP status into a short, user-facing reason. TV Time's sidecar
// commonly returns 502/503/504 while the backend winds down; surfacing that
// plainly means a "JSON parse error" (HTML error page) isn't mistaken for a
// bug in the export itself.
function describeHttpStatus(status) {
  if (status === 401 || status === 403) return `HTTP ${status} (session expired — reload app.tvtime.com)`;
  if (status === 429)                   return `HTTP 429 (rate limited)`;
  if (status === 502 || status === 503 || status === 504)
    return `HTTP ${status} (TV Time server temporarily unavailable)`;
  if (status === 599)                   return `HTTP 599 (request timed out after 60s)`;
  return `HTTP ${status}`;
}

// Per-run tally of HTTP failures, keyed by status code (or "network"). Feeds
// the end-of-run failure summaries ("… most common error: HTTP 502"). Reset at
// the start of each export. lastSidecarFailure holds the most recent failure so
// single-shot calls (e.g. custom lists) can report their exact status.
let httpFailureTally  = {};
let lastSidecarFailure = null; // { status } | { network: true }
// entityType → last HTTP status seen this run ("network" for network errors).
// Feeds the empty-export guard so 401 (expired session), 5xx (server down)
// and 200-but-empty (empty account / format change) are distinguishable.
let lastEntityStatus   = {};
function tallyHttpFailure(key) { httpFailureTally[key] = (httpFailureTally[key] ?? 0) + 1; }
function dominantFailureReason() {
  const entries = Object.entries(httpFailureTally);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [key] = entries[0];
  return key === "network" ? "network errors" : describeHttpStatus(Number(key));
}

// ---------------------------------------------------------------------------
// Lecture des credentials depuis le storage persistant au démarrage
// ---------------------------------------------------------------------------
chrome.storage.session.get(["credentials"], (result) => {
  try {
    if (chrome.runtime.lastError) {
      console.error("[TVTO BG] boot-time session.get error:", chrome.runtime.lastError.message);
      return;
    }
    if (result?.credentials) {
      cachedCredentials = result.credentials;
    }
  } catch (e) {
    console.error("[TVTO BG] boot-time session.get callback threw:", e);
  }
});

// ---------------------------------------------------------------------------
// Listener principal
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case "CREDENTIALS_FROM_PAGE": {
      const { userId, token } = message;
      if (userId && token) {
        const creds = { userId, token };
        cachedCredentials = creds;
        chrome.storage.session.set({ credentials: creds }, () => {
          sendResponse({ ok: true });
        });
      } else {
        sendResponse({ ok: false, error: "userId ou token manquant." });
      }
      return true;
    }

    case "GET_CREDENTIALS": {
      chrome.storage.session.get(["credentials"], (data) => {
        if (data.credentials) cachedCredentials = data.credentials;
        sendResponse({ credentials: data.credentials ?? null });
      });
      return true;
    }

    case "START_EXPORT": {
      if (exportState.status === "running") {
        sendResponse({ ok: false, error: "Export déjà en cours." });
        return false;
      }

      const token  = message.token  ?? cachedCredentials?.token;
      const userId = message.userId ?? cachedCredentials?.userId;
      if (!token || !userId) {
        sendResponse({ ok: false, error: "Pas de credentials. Ouvre d'abord app.tvtime.com." });
        return false;
      }

      cachedCredentials = { token, userId };

      // Capture user-selected output options (default-safe: json / no-zip).
      const format    = ["json", "csv", "both"].includes(message.format) ? message.format : "json";
      const zipBundle = Boolean(message.zipBundle);

      chrome.tabs.query({ url: "https://app.tvtime.com/*" }, (tabs) => {
        if (!tabs?.length) {
          sendResponse({ ok: false, error: "Aucun onglet app.tvtime.com ouvert." });
          return;
        }

        // Prefer fully-loaded, non-discarded tabs; fall back to any tab if none qualify.
        const best = tabs.find(t => t.status === "complete" && !t.discarded) ?? tabs[0];

        exportCancelled = false;
        exportState = { status: "running", step: "Step 1/5: Fetching your shows...", stepIndex: 1, fetchCount: "", loaded: 0, total: null, result: null, error: null, format, zipBundle };
        sendResponse({ ok: true });

        runExport(userId, token, best.id);
      });
      return true;
    }

    case "CANCEL_EXPORT": {
      // Flip the flag; the running pipeline will observe it at the next checkpoint
      // and throw CANCEL_SENTINEL, which is converted to status: "cancelled" below.
      if (exportState.status === "running") {
        exportCancelled = true;
      }
      // If nothing is running, just move to a clean cancelled state so the popup
      // can observe it on its next poll.
      exportState = { status: "cancelled", step: null, stepIndex: 0, fetchCount: "", loaded: 0, total: null, result: null, error: null };
      sendResponse({ ok: true });
      return false;
    }

    case "EXPORT_PROGRESS": {
      sendResponse({ ...exportState });
      return false;
    }

    case "RESET_EXPORT": {
      exportCancelled = false;
      exportState = { status: "idle", step: null, stepIndex: 0, fetchCount: "", loaded: 0, total: null, result: null, error: null };
      sendResponse({ ok: true });
      return false;
    }

    default:
      sendResponse({ ok: false, error: `Message inconnu : ${message.type}` });
      return false;
  }
});

// ---------------------------------------------------------------------------
// Fetch paginé générique dans le MAIN world (via sidecar TV Time).
// Token lu depuis localStorage avec suppression des guillemets JSON.
// ---------------------------------------------------------------------------
async function fetchObjectsViaTab(token, innerUrl, entityType, pageLimit, onPage = null) {
  const o_b64   = btoa(innerUrl).replace(/=/g, "");
  const base    = "https://app.tvtime.com/sidecar?o_b64=" + o_b64 +
                  "&entity_type=" + entityType + "&page_limit=" + pageLimit;
  const headers = {
    "Authorization":  "Bearer " + token,
    "App-Version":    "2025082201",
    "Client-Version": "10.10.0"
  };

  // Paginate via page_offset (0, pageLimit, 2×pageLimit, …).
  // Earlier revisions used &page=1,2,3 but the sidecar silently ignored it
  // and kept returning the first batch — users with 4000+ movies saw only
  // the first 1000. The correct TV Time param is page_offset (object
  // index, not page index). The duplicate-first-uuid guard is kept as a
  // defensive stop in case a future backend tweak makes page_offset a
  // no-op too.
  let   allObjects    = [];
  let   pageOffset    = 0;
  let   lastFirstUuid    = null;
  let   consecutiveFails = 0;       // consecutive pages that exhausted all retries
  const MAX_CONSEC_FAILS = 5;       // break the whole loop only after this many in a row

  pageLoop: while (true) {
    const url = base + "&page_offset=" + pageOffset;

    // Per-page retry loop for 5xx errors (Portugal sidecar returns intermittent
    // 504 Gateway Timeout on individual pages: a single failure must not lose
    // the whole pagination). Up to 5 retries with exponential backoff
    // (1s, 2s, 4s, 8s, 16s). 4xx errors (auth) still break immediately so
    // we do not hammer the API on permanent failures.
    const MAX_RETRIES = 5;
    let r, text, data;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      data = undefined;
      let jsonFail = null;
      try {
        r = await fetchWithTimeout(url, { headers });
        text = await r.text();
      } catch (fetchErr) {
        // Timeout (AbortError — during headers OR the body read) or network
        // failure — synthesize a 5xx-like response so the existing
        // retry/skip-and-continue logic applies unchanged.
        r    = { ok: false, status: 599 };
        text = `(${fetchErr?.name ?? "network error"})`;
      }
      lastEntityStatus[entityType] = r.status; // guard diagnostics (last seen wins)
      // A 200 can still carry a truncated/incomplete body when the server is
      // overloaded (HTTP 200 but "Unexpected end of JSON input"). Parse INSIDE
      // the retry loop so a JSON.parse failure on a 200 is treated as a
      // RETRYABLE transient failure — synthesize a 599 and fall through to the
      // same backoff/skip logic as 5xx. A truncated body is usually transient,
      // so a retry often gets a complete response; a genuinely malformed body
      // keeps failing and is skipped after retries, same as before.
      if (r.ok) {
        try {
          data = JSON.parse(text);
          break; // parsed a complete body — done retrying
        } catch (jsonErr) {
          jsonFail = jsonErr.message;
          r = { ok: false, status: 599 };
          lastEntityStatus[entityType] = r.status;
        }
      }
      if (r.status >= 400 && r.status < 500) {
        recordExportError(`${entityType} page @${pageOffset}: ${describeHttpStatus(r.status)} — stopping.`);
        break pageLoop; // 4xx: return whatever we've collected so far
      }
      if (attempt >= MAX_RETRIES) {
        recordExportError(jsonFail
          ? `${entityType} page @${pageOffset}: HTTP 200 but response was not valid JSON (${jsonFail}) — exhausted ${MAX_RETRIES} retries, skipping page`
          : `${entityType} page @${pageOffset}: HTTP ${r.status} — exhausted ${MAX_RETRIES} retries, skipping page`);
        consecutiveFails++;
        if (consecutiveFails >= MAX_CONSEC_FAILS) { break pageLoop; }
        pageOffset += pageLimit;
        continue pageLoop;
      }
      const delayMs = 1000 * Math.pow(2, attempt);
      console.warn(`[TVTO] fetchObjectsViaTab ${jsonFail ? 'truncated JSON (HTTP 200)' : 'HTTP ' + r.status} at offset ${pageOffset}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms — url: ${url}`);
      // Surface the retry in the popup — a failing first page used to mean
      // minutes of a frozen label (up to 6×60s + backoff per page). Guarded:
      // a label callback must never break the fetch.
      if (onPage) {
        try {
          onPage(Math.floor(pageOffset / pageLimit) + 1, allObjects.length,
                 `attempt ${attempt + 2}/${MAX_RETRIES + 1} — server busy, retrying`);
        } catch (_) {}
      }
      await new Promise(res => setTimeout(res, delayMs));
    }
    if (!r.ok) { // safety net: should be unreachable
      consecutiveFails++;
      if (consecutiveFails >= MAX_CONSEC_FAILS) break pageLoop;
      pageOffset += pageLimit;
      continue pageLoop;
    }

    // data was parsed inside the retry loop above (a truncated body on a 200
    // is retried there, not skipped here).
    const objects = data?.data?.objects ?? [];
    if (objects.length === 0) break;

    // Some regional backends (seen from Argentina) ignore page_limit on the
    // watches endpoint and return the ENTIRE collection in one response —
    // same class of bug as cgwBase ignoring page_offset. If a page returns
    // more objects than requested, pagination is meaningless and we already
    // have everything; requesting "page 2" would only re-download the same
    // giant payload (and previously hung on the unbounded body read).
    if (objects.length > pageLimit) {
      allObjects = allObjects.concat(objects);
      console.warn(`[TVTO] fetchObjectsViaTab (${entityType}): server ignored page_limit, got ${objects.length.toLocaleString()} in one response — pagination complete`);
      if (onPage) { try { onPage(1, allObjects.length); } catch (_) {} }
      break;
    }

    const firstUuid = objects[0]?.uuid;
    if (firstUuid && firstUuid === lastFirstUuid) break;

    allObjects = allObjects.concat(objects);
    lastFirstUuid    = firstUuid;
    consecutiveFails = 0; // successful page resets the consecutive-fail streak

    // Progress feedback — long paginations (watch history can run hundreds of
    // pages) must never look frozen. Guarded: a label callback must not be
    // able to break the fetch.
    if (onPage) {
      try { onPage(Math.floor(pageOffset / pageLimit) + 1, allObjects.length); } catch (_) {}
    }

    if (objects.length < pageLimit) break;
    pageOffset += pageLimit;
  }

  return allObjects;
}

// ---------------------------------------------------------------------------
// Shared sidecar fetch with retry on transient 5xx (502/503/504).
// TV Time's backend is winding down and returns intermittent 502 Bad Gateway
// on individual requests. The paginated fetch (fetchObjectsViaTab) already
// retries, but the single-shot detail endpoints (episodes, movie details,
// favorites, lists) previously gave up on the first failure — so one transient
// 502 permanently dropped that item. Retry up to 3 times with exponential
// backoff (1s, 2s, 4s); 4xx (auth/not-found) returns immediately — retrying a
// permanent failure only hammers the API. Network errors are retried too.
// Returns the Response on success or null once exhausted (callers already
// treat null as "this item failed"). Per-item failures are tallied and logged
// to the console; the popup panel gets concise end-of-run summaries instead of
// one noisy line per failed item.
// ---------------------------------------------------------------------------
// 60 s watchdog on every sidecar fetch — a hung connection aborts and is then
// handled exactly like a transient 5xx by the callers' retry / skip-and-
// continue logic (fetchObjectsViaTab synthesizes an HTTP 599 response;
// fetchSidecarWithRetry's network-error path retries with backoff).
const SIDECAR_TIMEOUT_MS = 60000;
async function fetchWithTimeout(url, options = {}, timeoutMs = SIDECAR_TIMEOUT_MS) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  // fetch() resolves on HEADERS only. Clearing the timer here used to leave
  // text()/json() unbounded — a slow-trickling giant body (24k objects from
  // the Argentine backend) hung forever. Keep the watchdog armed until the
  // body is actually consumed: on timeout the abort also rejects the
  // in-flight body read, and callers' existing catch / 599 logic applies.
  return {
    ok:         r.ok,
    status:     r.status,
    statusText: r.statusText,
    headers:    r.headers,
    text: async () => { try { return await r.text(); } finally { clearTimeout(timer); } },
    json: async () => { try { return await r.json(); } finally { clearTimeout(timer); } },
  };
}

// Sentinel returned by fetchSidecarWithRetry on 4xx: the item is permanently
// gone (deleted show/movie, bad id). Callers must report it as failed but
// NEVER re-queue it — the 100/50-round retry floors only make sense for
// transient failures (5xx/599/network).
const PERMANENT_FAILURE = Symbol("permanent-4xx-failure");

const SIDECAR_HEADERS = token => ({
  "Authorization":  "Bearer " + token,
  "App-Version":    "2025082201",
  "Client-Version": "10.10.0"
});

async function fetchSidecarWithRetry(url, token, { retries = 3, label = "sidecar" } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetchWithTimeout(url, { headers: SIDECAR_HEADERS(token) });
    } catch (netErr) {
      if (attempt >= retries) {
        tallyHttpFailure("network");
        lastSidecarFailure = { network: true };
        console.error(`[TVTO] ${label}: network error after ${retries} retries — ${netErr.message}`);
        return null;
      }
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    if (r.ok) return r;
    if (r.status >= 400 && r.status < 500) {
      tallyHttpFailure(r.status);
      lastSidecarFailure = { status: r.status };
      // warn, not error: an expected 4xx (deleted show/movie) must not show up
      // as a red extension error in chrome://extensions and alarm users. It
      // still reaches the Details panel via the end-of-run summaries.
      console.warn(`[TVTO] ${label}: ${describeHttpStatus(r.status)} — not retried`);
      return PERMANENT_FAILURE; // 4xx is permanent — don't retry, don't re-queue
    }
    // 5xx (502/503/504…) — retry with backoff unless exhausted.
    if (attempt >= retries) {
      tallyHttpFailure(r.status);
      lastSidecarFailure = { status: r.status };
      console.error(`[TVTO] ${label}: ${describeHttpStatus(r.status)} — gave up after ${retries} retries`);
      return null;
    }
    console.warn(`[TVTO] ${label}: HTTP ${r.status}, retry ${attempt + 1}/${retries} in ${1000 * Math.pow(2, attempt)}ms`);
    await sleep(1000 * Math.pow(2, attempt));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch épisodes d'une série via msapi.tvtime.com (un seul appel renvoie
// TOUS les épisodes, toutes saisons confondues).
//
// Endpoint : GET https://msapi.tvtime.com/v1/series/{seriesId}/episodes
// seriesId = TV Time show ID (show.id dans la réponse follows), PAS le TVDB ID.
//
// Réponse : { status: "success", data: [{ id, number, name, is_special,
//                                          season: { number } }, ...] }
//
// Exécuté directement depuis le service worker (plus de MAIN world /
// executeScript / polling). On regroupe la liste plate par season.number
// pour reconstituer la structure { seasons: [{ number, episodes: [...] }] }
// que la suite du pipeline attend déjà.
// ---------------------------------------------------------------------------
async function fetchSingleViaTab(token, seriesId) {
  const innerUrl = `https://msapi.tvtime.com/v1/series/${seriesId}/episodes`;
  const url = `https://app.tvtime.com/sidecar?o_b64=${btoa(innerUrl).replace(/=/g, '')}`;

  const response = await fetchSidecarWithRetry(url, token, { retries: 1, label: `series ${seriesId} episodes` });
  if (response === PERMANENT_FAILURE) return PERMANENT_FAILURE;
  if (!response) return null;
  const raw = await response.json().catch(() => null);
  if (!raw?.data) return null;

  const seasonMap = new Map();
  for (const ep of raw.data) {
    const seasonNum = ep?.season?.number ?? 0;
    if (!seasonMap.has(seasonNum)) {
      seasonMap.set(seasonNum, { number: seasonNum, episodes: [] });
    }
    seasonMap.get(seasonNum).episodes.push(ep);
  }
  const seasons = [...seasonMap.values()].sort((a, b) => a.number - b.number);
  return { seasons };
}

// ---------------------------------------------------------------------------
// Fetch une liste favoris (favorite-series ou favorite-movies) via le sidecar
// TV Time. Retourne un tableau d'IDs (data.objects[].id). En cas d'erreur,
// renvoie [] pour ne pas bloquer l'export.
// ---------------------------------------------------------------------------
async function fetchFavoritesList(token, userId, listKey, idField = "id") {
  const innerUrl = `https://msapi.tvtime.com/prod/v2/lists/user/${userId}/lists/${listKey}`;
  const url = `https://app.tvtime.com/sidecar?o_b64=${btoa(innerUrl).replace(/=/g, '')}`;

  const response = await fetchSidecarWithRetry(url, token, { label: `favorites ${listKey}` });
  if (!response || response === PERMANENT_FAILURE) return [];
  const raw = await response.json().catch(() => null);
  const objects = raw?.data?.objects ?? raw?.objects ?? [];
  return objects.map(o => o?.[idField]).filter(v => v != null);
}

// ---------------------------------------------------------------------------
// Formate un watched_at ISO 8601 en "YYYY-MM-DD HH:MM:SS".
// Entrée : "2024-01-21T00:33:46.403717Z" (ou toute variante ISO)
// Sortie : "2024-01-21 00:33:46"
// Retourne null si la valeur est null / undefined / non parseable.
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatWatchedAt(raw) {
  if (!raw) return null;
  // Remplace le T par un espace et coupe tout ce qui suit les secondes
  const s = raw.replace("T", " ").replace(/(\d{2}:\d{2}:\d{2}).*$/, "$1");
  // Vérifie qu'on obtient bien "YYYY-MM-DD HH:MM:SS" (19 chars)
  if (s.length < 19) return null;
  // ISO 8601 UTC — même format pour épisodes et films ("YYYY-MM-DDTHH:MM:SSZ").
  return s.substring(0, 19).replace(" ", "T") + "Z";
}

// ---------------------------------------------------------------------------
// Re-read the JWT token from the TV Time tab's localStorage. Returns null if
// the read fails or the token isn't present, so callers can fall back to the
// token they already hold. Used for PROACTIVE token refresh at major pipeline
// boundaries — for users with 4000+ shows an export can outlast the JWT
// lifetime, and without a fresh token every watch-history / movie-detail
// fetch silently returns 0 results.
// ---------------------------------------------------------------------------
const TOKEN_REFRESH_TIMEOUT_MS = 5000;
async function getFreshToken(tabId) {
  try {
    // 5 s watchdog — executeScript into a frozen / unresponsive tab can stay
    // pending forever (never resolves, never rejects), which used to hang the
    // whole export at a step boundary. A timeout resolves to null and every
    // caller already treats null as "keep the existing token".
    const result = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world:  "MAIN",
        func:   () => localStorage.getItem("flutter.jwtToken")?.replace(/^"|"$/g, "")
      }),
      new Promise(resolve => setTimeout(() => resolve(null), TOKEN_REFRESH_TIMEOUT_MS))
    ]);
    return result?.[0]?.result ?? null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch les listes utilisateur via le sidecar TV Time.
// Endpoint : GET sidecar?o_b64=BASE64(msapi …/v2/lists/user/{userId}/lists)&expand=meta
// Retourne un tableau brut de listes (chacune avec objects[]).
// ---------------------------------------------------------------------------
async function fetchListsViaTab(token, userId) {
  const innerUrl   = `https://msapi.tvtime.com/prod/v2/lists/user/${userId}`;
  const b64        = btoa(innerUrl).replace(/=/g, "");
  const sidecarUrl = `https://app.tvtime.com/sidecar?o_b64=${b64}&expand=meta`;

  const r = await fetchSidecarWithRetry(sidecarUrl, token, { label: "custom lists" });
  if (!r || r === PERMANENT_FAILURE) {
    lastEntityStatus.lists = lastSidecarFailure?.network ? "network" : (lastSidecarFailure?.status ?? null);
    // Non-ok / network failure — the helper already tallied + logged the status.
    // Surface one panel line so the user knows lists were skipped and why.
    const why = lastSidecarFailure?.network ? "network error"
              : lastSidecarFailure?.status  ? describeHttpStatus(lastSidecarFailure.status)
              : "request failed";
    recordExportError(`Custom lists skipped — ${why}.`);
    return [];
  }
  lastEntityStatus.lists = r.status;
  const text = await r.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // 200 OK but the body wasn't JSON (e.g. an HTML error page). Include the
    // HTTP status so this reads as a server issue, not a parsing bug.
    recordExportError(`Custom lists skipped — HTTP ${r.status} but response was not valid JSON (${e.message}).`);
    return [];
  }
  if (Array.isArray(raw))       return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

// ---------------------------------------------------------------------------
// Fetch les détails d'un film via le sidecar TV Time.
// Endpoint : GET sidecar?o_b64=BASE64(msapi …/v1/movies/{uuid})&random=true
// Retourne le JSON brut de la réponse, ou null en cas d'erreur/timeout.
// ---------------------------------------------------------------------------
async function fetchMovieDetailViaTab(token, uuid) {
  const innerUrl   = `https://msapi.tvtime.com/prod/v1/movies/${uuid}`;
  const b64        = btoa(innerUrl).replace(/=/g, "");
  const sidecarUrl = `https://app.tvtime.com/sidecar?o_b64=${b64}&random=true`;

  const r = await fetchSidecarWithRetry(sidecarUrl, token, { retries: 1, label: `movie ${uuid}` });
  if (r === PERMANENT_FAILURE) return PERMANENT_FAILURE;
  if (!r) return null;
  const data = await r.json().catch(() => null);
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Export 5 étapes :
//   1. Shows follows (series + anime)
//   2. Watch history (épisodes + films)
//   3. Détails saisons/épisodes par série (msapi.tvtime.com/v1/series/{id}/episodes)
//   4. Détails films (msapi.tvtime.com/prod/v1/movies)
//   5. Listes utilisateur (msapi.tvtime.com/prod/v2/lists)
//
// Films : follows/movie pour métadonnées (title, tvdb, imdb) + vus ET non vus
//         watches/movie pour watched_at — fusion par UUID
//
// Produit 3 fichiers au format TV Time Liberator : shows + movies + lists.
// ---------------------------------------------------------------------------
async function runExport(userId, token, tabId) {
  const exportStartTime = Date.now();
  exportErrors = []; // fresh log for this run
  httpFailureTally = {}; lastSidecarFailure = null; lastEntityStatus = {};

  // Pin the TV Time tab for the duration of the export — Memory Saver
  // discarding the tab mid-run hangs MAIN-world executeScript (token refresh)
  // and drops the session the sidecar depends on. Restored in finally.
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); }
  catch (_) { /* tab already closed — the export will surface that on its own */ }
  const cgwBase    = "https://msapi.tvtime.com/prod/v1/tracking/cgw/follows/user/" + userId;
  const watchesBase= "https://msapi.tvtime.com/prod/v1/tracking/watches/user/"     + userId;

  // Throws CANCEL_SENTINEL if the user clicked Cancel. Called at each major
  // pipeline checkpoint; the outer try/catch converts it to status "cancelled".
  const throwIfCancelled = () => {
    if (exportCancelled) throw new Error(CANCEL_SENTINEL);
  };

  try {
    throwIfCancelled();
    // -------------------------------------------------------------------------
    // Étape 1 — Séries + animés suivis
    // -------------------------------------------------------------------------
    exportState.step      = "Step 1/5: Fetching your shows...";
    exportState.stepIndex = 1;
    exportState.pct       = null;

    // Proactive JWT refresh at the step boundary — cheap, and if the token has
    // been rotated by the TV Time tab since START_EXPORT we want every
    // downstream fetch to use the fresh value. Null result = keep existing
    // token; never fail the export on a refresh miss.
    {
      const fresh = await getFreshToken(tabId);
      if (fresh) {
        token = fresh;
        cachedCredentials = { ...cachedCredentials, token: fresh };
        chrome.storage.session.set({ credentials: cachedCredentials });
      }
    }

    // Fetch avec retry sur résultat vide — jusqu'à 3 tentatives, délai 2s entre chaque.
    async function fetchWithRetry(entityType, pageLimit, maxRetries = 3) {
      const onPage = (page, count, note) => {
        exportState.step = note
          ? `Step 1/5: Fetching your ${entityType} list... (page ${page}, ${note})`
          : `Step 1/5: Fetching your ${entityType} list... (page ${page}, ${count.toLocaleString()} so far)`;
      };
      let results = await fetchObjectsViaTab(token, cgwBase, entityType, pageLimit, onPage);
      for (let attempt = 1; attempt < maxRetries && results.length === 0; attempt++) {
        await sleep(2000);
        results = await fetchObjectsViaTab(token, cgwBase, entityType, pageLimit, onPage);
      }
      return results;
    }

    const seriesRaw = await fetchWithRetry("series", 1000);
    throwIfCancelled();
    const animeRaw  = await fetchWithRetry("anime",  1000);
    throwIfCancelled();

    // Films — cgwBase (follows) retourne tracked/followed movies only.
    // Users who watched a movie without following it appear in the watches
    // endpoint but not in follows. Fetch both and deduplicate by UUID.
    const moviesFollowsRaw = await fetchWithRetry("movie", 100);
    throwIfCancelled();

    // Watches endpoint — picks up watched-but-not-followed movies.
    const movieWatchesRaw    = await fetchObjectsViaTab(token, watchesBase, "movie", 100,
      (page, count, note) => { exportState.step = note
        ? `Step 1/5: Fetching movie watch history... (page ${page}, ${note})`
        : `Step 1/5: Fetching movie watch history... (page ${page}, ${count.toLocaleString()} so far)`; });
    throwIfCancelled();
    const followedMovieUuids = new Set(moviesFollowsRaw.map(m => m.uuid).filter(Boolean));
    const watchOnlyMovies    = movieWatchesRaw.filter(m => m.uuid && !followedMovieUuids.has(m.uuid));

    // Enrich watch-only movies with full metadata from the detail endpoint.
    // Objects from the watches endpoint lack the meta structure (name, ids)
    // that cgwBase follows provide. Batch of 5, with up to 3 retry rounds.
    // Movies whose detail fetch exhausts retries keep no meta and will appear
    // in failedMovies (title === null) — same behaviour as other fetch failures.
    if (watchOnlyMovies.length > 0) {
      exportState.step = `Step 1/5: Fetching metadata for ${watchOnlyMovies.length} watch-only movie(s)...`;
      const WO_BATCH   = 5;
      const WO_TIMEOUT = 30000;
      let woRetryList  = [];

      for (let i = 0; i < watchOnlyMovies.length; i += WO_BATCH) {
        throwIfCancelled();
        exportState.step = `Step 1/5: Fetching metadata for watch-only movies... (${Math.min(i + WO_BATCH, watchOnlyMovies.length)}/${watchOnlyMovies.length})`;
        const batch   = watchOnlyMovies.slice(i, i + WO_BATCH);
        const results = await Promise.allSettled(
          batch.map(m =>
            Promise.race([
              fetchMovieDetailViaTab(token, m.uuid),
              new Promise(r => setTimeout(() => r(null), WO_TIMEOUT))
            ])
          )
        );
        results.forEach((res, j) => {
          const m    = batch[j];
          const data = res.status === "fulfilled" ? res.value : null;
          if (data === PERMANENT_FAILURE) {
            // 4xx — movie gone; keep meta absent (→ failedMovies), never re-queue.
          } else if (data) {
            m.meta = data?.data ?? data;
          } else {
            woRetryList.push(m);
          }
        });
      }

      // Retry — up to 3 rounds
      let woAttempts = 0;
      while (woRetryList.length > 0 && woAttempts < 3) {
        throwIfCancelled();
        woAttempts++;
        exportState.step = `Step 1/5: Retrying metadata for ${woRetryList.length} watch-only movie(s)... (round ${woAttempts}/3)`;
        const stillFailed = [];
        for (let i = 0; i < woRetryList.length; i += WO_BATCH) {
          throwIfCancelled();
          const batch   = woRetryList.slice(i, i + WO_BATCH);
          const results = await Promise.allSettled(
            batch.map(m =>
              Promise.race([
                fetchMovieDetailViaTab(token, m.uuid),
                new Promise(r => setTimeout(() => r(null), WO_TIMEOUT))
              ])
            )
          );
          results.forEach((res, j) => {
            const m    = batch[j];
            const data = res.status === "fulfilled" ? res.value : null;
            if (data === PERMANENT_FAILURE) { /* 4xx — drop from retries */ }
            else if (data) { m.meta = data?.data ?? data; }
            else           { stillFailed.push(m); }
          });
        }
        woRetryList = stillFailed;
      }
      // Remaining failures: meta stays absent → title=null → caught by failedMovies.
    }

    const moviesRaw = [...moviesFollowsRaw, ...watchOnlyMovies];

    const showsRaw = [...seriesRaw, ...animeRaw];
    exportState.loaded     = showsRaw.length;
    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesFollowsRaw.length.toLocaleString()} followed + ${watchOnlyMovies.length.toLocaleString()} watch-only movies fetched`;

    // -------------------------------------------------------------------------
    // Étape 2 — Historique de visionnage (épisodes + films)
    // Les watches films contiennent déjà toutes les métadonnées (title, id.tvdb, id.imdb)
    // -------------------------------------------------------------------------
    exportState.step      = "Step 2/5: Fetching watch history...";
    exportState.stepIndex = 2;

    // Proactive JWT refresh — watch-history requests are the most impacted
    // when a token ages out mid-export: the backend answers 200 with an empty
    // objects[] array, so the export looks successful but all watch dates
    // vanish silently. Refreshing here is the cheapest insurance.
    {
      const fresh = await getFreshToken(tabId);
      if (fresh) {
        token = fresh;
        cachedCredentials = { ...cachedCredentials, token: fresh };
        chrome.storage.session.set({ credentials: cachedCredentials });
      }
    }

    // DEBUG (v1.2.14-debug-sidecar-100): revert to sidecar path with
    // page_limit=100 to test whether the sidecar 504 timeout correlates
    // with response size. Direct msapi.tvtime.com calls fail with
    // 403 MissingAPIKey for Portugal users (only the sidecar authenticates
    // correctly). fetchObjectsViaTab logs URL + status on errors already.
    const episodeWatches = await fetchObjectsViaTab(token, watchesBase, "episode", 100,
      (page, count, note) => { exportState.step = note
        ? `Step 2/5: Fetching watch history... (page ${page}, ${note})`
        : `Step 2/5: Fetching watch history... (page ${page}, ${count.toLocaleString()} episodes so far)`; });
    throwIfCancelled();

    // Filter episode watches to only include episodes from followed shows.
    // This removes orphaned watch records for shows the user has unfollowed,
    // which would otherwise appear as ghost watched episodes in the export.
    const followedSeriesUuids = new Set(
      [...seriesRaw, ...animeRaw].map(s => s.uuid).filter(Boolean)
    );
    const filteredWatches = episodeWatches.filter(w => followedSeriesUuids.has(w.series_uuid));

    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesRaw.length.toLocaleString()} movies (${moviesFollowsRaw.length.toLocaleString()} followed + ${watchOnlyMovies.length.toLocaleString()} watch-only) · ${filteredWatches.length.toLocaleString()} eps fetched`;

    // Index watched_at — double clé (episode_id, uuid) pour couvrir tous les formats
    const watchedAtMap = new Map();
    filteredWatches.forEach(w => {
      const entry = { watched_at: w.watched_at ?? null, rewatch_count: w.rewatch_count ?? 0 };
      if (w.episode_id) watchedAtMap.set(String(w.episode_id), entry);
      if (w.uuid)       watchedAtMap.set(String(w.uuid),       entry);
    });

    // -------------------------------------------------------------------------
    // Fetch favorites lists (series + movies) in parallel.
    // Runs between watch history and season details so that favorite flags
    // are available during normalization.
    // -------------------------------------------------------------------------
    exportState.step = "Fetching your favorites...";

    const [favSeriesIdsArr, favMovieIdsArr] = await Promise.all([
      fetchFavoritesList(token, userId, "favorite-series", "id"),
      fetchFavoritesList(token, userId, "favorite-movies", "uuid")
    ]);
    throwIfCancelled();

    const favoriteSeriesIds = new Set(favSeriesIdsArr);
    const favoriteMoviesIds = new Set(favMovieIdsArr);

    // -------------------------------------------------------------------------
    // Étape 3 — Détails saisons/épisodes par série
    // Batch parallèle de 5, timeout individuel (10s) + timeout batch (15s).
    // Pas de retry — évite les blocages du service worker MV3.
    // -------------------------------------------------------------------------
    exportState.step      = `Step 3/5: Fetching episode details... (0/${showsRaw.length})`;
    exportState.stepIndex = 3;

    const BATCH_SIZE   = 10;
    const SHOW_TIMEOUT = 90000;
    const failedShows  = [];
    const permanentFailedShows = []; // 4xx — reported as failed, excluded from every retry loop

    // Pré-calcul : liste plate des shows avec leur seriesId (TV Time ID) et title.
    // Le nouvel endpoint msapi.tvtime.com/v1/series/{seriesId}/episodes utilise
    // l'ID TV Time (show.id), PAS le TVDB ID.
    const showsNeedingSeasons = showsRaw.map(show => ({
      seriesId: show.meta?.id ?? null,
      title:    show.meta?.name ?? show.meta?.title ?? null,
      _ref:     show   // référence vers l'objet d'origine pour mutater show.seasons
    })).filter(s => s.seriesId != null);

    // Shows sans seriesId → seasons vide directement
    showsRaw.forEach(show => {
      if (!show.id) show.seasons = [];
    });

    for (let i = 0; i < showsNeedingSeasons.length; i += BATCH_SIZE) {
      throwIfCancelled();
      const batch = showsNeedingSeasons.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(show =>
          Promise.race([
            fetchSingleViaTab(token, show.seriesId),
            new Promise(r => setTimeout(() => r(null), SHOW_TIMEOUT))
          ])
        )
      );
      results.forEach((res, j) => {
        const show  = batch[j];
        const value = res.status === "fulfilled" ? res.value : null;
        if (value === PERMANENT_FAILURE) {
          // 4xx — series gone from the API; report it, never retry it.
          show._ref.seasons = [];
          permanentFailedShows.push(show);
          return;
        }
        show._ref.seasons = value?.seasons ?? [];
        if (!value) failedShows.push({ title: show.title, seriesId: show.seriesId });
      });
      if (i % 15 === 0) {
        const pct = 30 + Math.round((i / showsNeedingSeasons.length) * 70);
        exportState.pct  = pct;
        exportState.step = `Step 3/5: Fetching episode details... (${i + 1}/${showsNeedingSeasons.length})`;
      }
    }

    // Retry des séries échouées —
    // Au moins 50 tentatives garanties, puis arrêt si 10 rounds consécutifs sans amélioration.
    let retryList          = failedShows
      .map(f => showsNeedingSeasons.find(s => s.seriesId === f.seriesId))
      .filter(Boolean);

    let totalAttempts      = 0;
    let noImprovementCount = 0;
    let totalRecovered     = 0;

    while (retryList.length > 0) {
      throwIfCancelled();
      const before = retryList.length;

      // Refresh JWT token at the start of each retry round — long exports can
      // outlast the token's lifetime; re-reading from localStorage picks up any
      // token the TV Time app has already renewed automatically. Uses the
      // bounded getFreshToken helper (5 s watchdog): this loop can run 100+
      // rounds and a frozen tab must never hang it. Null = keep current token.
      {
        const fresh = await getFreshToken(tabId);
        if (fresh) {
          token = fresh;
          cachedCredentials = { ...cachedCredentials, token: fresh };
          chrome.storage.session.set({ credentials: cachedCredentials });
        }
      }

      exportState.step = `⏳ Retrying ${before} failed series... (attempt ${totalAttempts + 1}, recovered ${totalRecovered} so far)`;

      const stillFailed = [];
      for (let i = 0; i < retryList.length; i += BATCH_SIZE) {
        throwIfCancelled();
        const batch = retryList.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(show =>
            Promise.race([
              fetchSingleViaTab(token, show.seriesId),
              new Promise(r => setTimeout(() => r(null), SHOW_TIMEOUT))
            ])
          )
        );
        results.forEach((res, j) => {
          const show  = batch[j];
          const value = res.status === "fulfilled" ? res.value : null;
          if (value === PERMANENT_FAILURE) {
            permanentFailedShows.push(show); // 4xx mid-retry — drop from the list
          } else if (value) {
            show._ref.seasons = value?.seasons ?? [];
          } else {
            stillFailed.push(show);
          }
        });
      }

      retryList = stillFailed;
      totalAttempts++;

      if (retryList.length < before) {
        totalRecovered     += before - retryList.length;
        noImprovementCount  = 0;
      } else {
        noImprovementCount++;
      }

      if (totalAttempts >= 100 && noImprovementCount >= 20) break;
    }

    // failedShows entries still report tvdbId (from the show metadata) for the
    // CSV/JSON failure file — that output format is consumed by exporter.js.
    const finalFailed = [...retryList, ...permanentFailedShows].map(s => ({ title: s.title, tvdbId: s._ref?.meta?.id ?? null }));

    // ── Retry shows that came back with 0 episodes — up to 3 attempts, 90s each ─
    // These shows fetched successfully but returned empty season data.
    // Each show is retried sequentially (up to 3 times), stopping on first success.
    // Shows that exhaust all retries are marked so the HTML summary can flag them.
    const RETRY_TIMEOUT  = 90000;
    const MAX_EP_RETRIES = 3;

    const permanentSeriesIds = new Set(permanentFailedShows.map(s => s.seriesId));
    const zeroEpShows = showsNeedingSeasons.filter(show => {
      if (permanentSeriesIds.has(show.seriesId)) return false; // 4xx — pointless to retry
      const seasons  = show._ref.seasons ?? [];
      const totalEps = seasons.reduce((sum, s) => sum + (s.episodes?.length ?? 0), 0);
      return seasons.length === 0 || totalEps === 0;
    });

    // Set to track shows that failed all 3 retries (keyed by seriesId)
    const exhaustedRetries = new Set();

    if (zeroEpShows.length > 0) {
      exportState.step = `🔄 Retrying ${zeroEpShows.length} show(s) with no episode data (up to 3×90s)...`;

      let zeroEpDone = 0;
      for (const show of zeroEpShows) {
        throwIfCancelled();
        zeroEpDone++;
        exportState.step = `🔄 Retrying show(s) with no episode data... (${zeroEpDone}/${zeroEpShows.length}, up to 3×90s each)`;
        let recovered = false;
        for (let attempt = 1; attempt <= MAX_EP_RETRIES; attempt++) {
          throwIfCancelled();
          let value = null;
          try {
            value = await Promise.race([
              fetchSingleViaTab(token, show.seriesId),
              new Promise(r => setTimeout(() => r(null), RETRY_TIMEOUT))
            ]);
          } catch (_) { value = null; }

          if (value === PERMANENT_FAILURE) break; // series gone — stop retrying this show
          if (value) {
            const seasons  = value?.seasons ?? [];
            const totalEps = seasons.reduce((sum, s) => sum + (s.episodes?.length ?? 0), 0);
            if (totalEps > 0) {
              show._ref.seasons = seasons;
              recovered = true;
              break;
            }
          }
        }
        if (!recovered) exhaustedRetries.add(show.seriesId);
      }
    }

    // -------------------------------------------------------------------------
    // Normalisation — Format TV Time Liberator
    // -------------------------------------------------------------------------

    // Séries + animés → { uuid, id, created_at, title, status, seasons[] }
    const shows = showsRaw.map(show => ({
      uuid:             show.uuid                           ?? null,
      id:               { tvdb: show.meta?.id ?? null, imdb: null },
      created_at:       show.created_at                    ?? null,
      title:            show.meta?.name ?? show.meta?.title ?? null,
      status:           show.filter?.[1] ?? "unknown",
      is_favorite:      favoriteSeriesIds.has(show.meta?.id),
      _noEpisodeData:   exhaustedRetries.has(show.id ?? null),
      seasons:    (show.seasons ?? []).map(season => ({
        number:      season.number,
        is_specials: season.number === 0,
        episodes:    (season.episodes ?? []).filter(ep => {
          const n = (ep.name ?? ep.title ?? "").trim();
          return n.toUpperCase() !== "TBA";
        }).map(ep => ({
          id:         { tvdb: ep.id ?? null, imdb: null },
          number:     ep.number,
          name:       ep.name ?? ep.title ?? null,
          special:    ep.is_special ?? (season.number === 0),
          is_watched:    watchedAtMap.has(String(ep.id?.tvdb ?? ep.id)) || (ep.is_watched ?? false),
          watched_at:    formatWatchedAt(watchedAtMap.get(String(ep.id?.tvdb ?? ep.id))?.watched_at),
          rewatch_count: watchedAtMap.get(String(ep.id?.tvdb ?? ep.id))?.rewatch_count ?? 0,
          watched_count: watchedAtMap.has(String(ep.id?.tvdb ?? ep.id))
            ? (watchedAtMap.get(String(ep.id?.tvdb ?? ep.id))?.rewatch_count ?? 0) + 1
            : (ep.is_watched ? 1 : 0)
        }))
      }))
    }));

    // Films — métadonnées depuis follows/détail ; statut vu + watched_at depuis
    // l'endpoint *watches* (les autres endpoints ne le portent pas). Indexé par
    // uuid, comme watchedAtMap pour les épisodes.
    const movieWatchedMap = buildMovieWatchedMap(movieWatchesRaw);
    const movies = moviesRaw.map(m => {
      // Cherche les métadonnées dans les emplacements connus
      const meta       = m.meta ?? m.content ?? m.movie ?? m.data ?? m ?? {};
      const extSources = meta?.external_sources ?? [];
      const tvdbSource = extSources.find?.(s => s.source === "tvdb" || s.source === "TVDB");
      const tvdbId     = tvdbSource ? parseInt(tvdbSource.id) : (meta?.tvdb_id ?? meta?.id_tvdb ?? null);
      const imdbId     = meta?.imdb_id ?? meta?.id_imdb ?? null;
      const title      = meta?.name ?? meta?.title ?? meta?.original_name ?? null;
      const watch      = resolveMovieWatchState(m, meta, movieWatchedMap);
      return {
        id:         { tvdb: tvdbId, imdb: imdbId },
        uuid:       m.uuid,
        created_at: m.created_at,
        title,
        year:          null, // populated in Step 4/5
        watched_at:    formatWatchedAt(watch.watched_at),
        is_watched:    watch.is_watched,
        is_favorite:   favoriteMoviesIds.has(m.uuid),
        rewatch_count: watch.rewatch_count
      };
    });

    const failedMovies = movies
      .filter(m => m.title === null)
      .map(m => ({ uuid: m.uuid, title: null }));

    // -------------------------------------------------------------------------
    // Étape 4 — Détails films (first_release_date → year)
    // Batch parallèle de 5. Retry jusqu'à 50 rounds min, arrêt si 10 rounds
    // consécutifs sans amélioration (même logique que les détails séries).
    // -------------------------------------------------------------------------
    exportState.step      = `Step 4/5: Fetching movie details... (0/${movies.length})`;
    exportState.stepIndex = 4;

    // Proactive JWT refresh — by the time we reach movie details on a large
    // library we've already burned several minutes on episode fetches, so the
    // token is the most likely to have rotated. Null = keep existing token.
    {
      const fresh = await getFreshToken(tabId);
      if (fresh) {
        token = fresh;
        cachedCredentials = { ...cachedCredentials, token: fresh };
        chrome.storage.session.set({ credentials: cachedCredentials });
      }
    }

    const MOVIE_BATCH   = 5;
    const MOVIE_TIMEOUT = 30000;
    const movieYearMap  = new Map(); // uuid → year (number)

    const moviesWithUuid = movies.filter(m => m.uuid);

    // Initial pass
    let movieRetryList = [];
    for (let i = 0; i < moviesWithUuid.length; i += MOVIE_BATCH) {
      throwIfCancelled();
      const batch   = moviesWithUuid.slice(i, i + MOVIE_BATCH);
      const results = await Promise.allSettled(
        batch.map(m =>
          Promise.race([
            fetchMovieDetailViaTab(token, m.uuid),
            new Promise(r => setTimeout(() => r(null), MOVIE_TIMEOUT))
          ])
        )
      );
      results.forEach((res, j) => {
        const movie = batch[j];
        const data  = res.status === "fulfilled" ? res.value : null;
        if (data === PERMANENT_FAILURE) {
          // 4xx — movie gone; year stays null, never re-queued.
        } else if (data) {
          const releaseDate = data?.first_release_date ?? data?.data?.first_release_date ?? null;
          if (releaseDate) movieYearMap.set(movie.uuid, new Date(releaseDate).getFullYear());
        } else {
          movieRetryList.push(movie);
        }
      });
      exportState.step = `Step 4/5: Fetching movie details... (${Math.min(i + MOVIE_BATCH, moviesWithUuid.length)}/${moviesWithUuid.length})`;
    }

    // Retry loop
    let mAttempts = 0, mNoImprove = 0, mRecovered = 0;
    while (movieRetryList.length > 0) {
      throwIfCancelled();
      const before = movieRetryList.length;
      exportState.step = `⏳ Retrying ${before} failed movie details... (attempt ${mAttempts + 1}, recovered ${mRecovered} so far)`;

      const stillFailed = [];
      for (let i = 0; i < movieRetryList.length; i += MOVIE_BATCH) {
        throwIfCancelled();
        const batch   = movieRetryList.slice(i, i + MOVIE_BATCH);
        const results = await Promise.allSettled(
          batch.map(m =>
            Promise.race([
              fetchMovieDetailViaTab(token, m.uuid),
              new Promise(r => setTimeout(() => r(null), MOVIE_TIMEOUT))
            ])
          )
        );
        results.forEach((res, j) => {
          const movie = batch[j];
          const data  = res.status === "fulfilled" ? res.value : null;
          if (data === PERMANENT_FAILURE) {
            // 4xx mid-retry — drop from the list.
          } else if (data) {
            const releaseDate = data?.first_release_date ?? data?.data?.first_release_date ?? null;
            if (releaseDate) movieYearMap.set(movie.uuid, new Date(releaseDate).getFullYear());
          } else {
            stillFailed.push(movie);
          }
        });
      }

      movieRetryList = stillFailed;
      mAttempts++;
      if (movieRetryList.length < before) { mRecovered += before - movieRetryList.length; mNoImprove = 0; }
      else mNoImprove++;
      if (mAttempts >= 50 && mNoImprove >= 10) break;
    }

    // Apply years to movie objects
    movies.forEach(m => { m.year = movieYearMap.get(m.uuid) ?? null; });

    throwIfCancelled();

    // -------------------------------------------------------------------------
    // Étape 5 — Listes utilisateur
    // -------------------------------------------------------------------------
    exportState.step      = "Step 5/5: Fetching your lists...";
    exportState.stepIndex = 5;

    let listsRaw = [];
    try {
      // fetchListsViaTab reports its own failures to the panel and returns [];
      // this catch is a safety net for anything unexpected (no duplicate log).
      listsRaw = await fetchListsViaTab(token, userId);
    } catch (listsErr) {
      recordExportError(`Custom lists skipped — ${listsErr.message}`);
    }

    const lists = listsRaw.map(list => ({
      id:          list.id          ?? null,
      name:        list.name        ?? null,
      description: list.description ?? "",
      is_public:   list.is_public   ?? false,
      created_at:  list.created_at  ?? null,
      items: (list.objects ?? []).map((obj, idx) => {
        if (obj.type === "series") {
          return {
            type:         "series",
            tvdb_id:      obj.id   ?? null,
            name:         obj.name ?? null,
            custom_order: obj.custom_order ?? idx
          };
        }
        return {
          type:         "movie",
          uuid:         obj.uuid ?? null,
          name:         obj.name ?? null,
          custom_order: obj.custom_order ?? idx
        };
      })
    }));

    const watchedEpisodes = shows.reduce((acc, show) =>
      acc + (show.seasons ?? []).reduce((sacc, season) => {
        if (season.number === 0) return sacc; // skip specials
        return sacc + (season.episodes ?? []).filter(ep => ep.is_watched && !ep.special).length;
      }, 0)
    , 0);

    // Empty-export guard — an export that came back with zero shows AND zero
    // movies is never a real "success". It almost always means the JWT expired
    // mid-run or the sidecar answered 4xx/5xx: the follows/watch fetches return
    // [] and the pipeline otherwise completes with "Great success!" and 0/0/0.
    // Fail loudly instead so the user knows to retry rather than trusting an
    // empty file. (A user with only custom lists still gets their export.)
    if (shows.length === 0 && movies.length === 0 && lists.length === 0) {
      // Diagnostic: without the underlying HTTP statuses neither the user nor
      // support can tell an expired session (401/403) from server trouble
      // (5xx/599) from a genuinely empty account (200s but no objects).
      const fmt = s => s == null ? "no response" : (s === "network" ? "network error" : `HTTP ${s}`);
      const showsStatus = lastEntityStatus.series ?? lastEntityStatus.anime ?? null;
      const movieStatus = lastEntityStatus.movie ?? null;
      const listsStatus = lastEntityStatus.lists ?? null;
      const all       = [showsStatus, movieStatus, listsStatus];
      const numeric   = all.filter(s => typeof s === "number");
      const isAuth    = numeric.length > 0 && numeric.every(s => s === 401 || s === 403);
      const isServer  = numeric.some(s => s >= 500);
      const isNetwork = all.includes("network");
      const allOk     = numeric.length > 0 && numeric.every(s => s === 200);
      const verdict = isAuth    ? "session likely expired"
                    : isServer  ? "TV Time servers temporarily unavailable"
                    : isNetwork ? "network errors — check your connection"
                    : allOk     ? "server answered normally — account may be empty, or the response format changed"
                    :             "cause unclear";
      recordExportError(`Last server responses: shows ${fmt(showsStatus)}, movies ${fmt(movieStatus)}, lists ${fmt(listsStatus)} — ${verdict}.`);
      throw new Error(
          isAuth   ? "Export returned no data — your TV Time session has expired. Log in again at app.tvtime.com, then retry."
        : isServer ? "Export returned no data — TV Time servers are temporarily unavailable. Please retry in a few minutes."
        : "Export returned no shows, no movies and no lists. Your TV Time session likely " +
          "expired or the server is temporarily unavailable. Reload app.tvtime.com, " +
          "make sure you're logged in, then try again."
      );
    }

    // Summarise partial failures into the error log so they surface in the
    // popup alongside any transient fetch errors already recorded.
    if (finalFailed.length > 0) {
      const reason = dominantFailureReason();
      recordExportError(`${finalFailed.length} series could not be fully fetched (missing seasons/episodes)${reason ? ` — most common error: ${reason}` : ""}.`);
    }
    if (failedMovies.length > 0) {
      const reason = dominantFailureReason();
      recordExportError(`${failedMovies.length} movie(s) could not be exported (no metadata)${reason ? ` — most common error: ${reason}` : ""}.`);
    }

    const result = { shows, movies, lists, failedShows: finalFailed, failedMovies, watchedEpisodes, durationMs: Date.now() - exportStartTime, zipBundle: exportState.zipBundle };

    // Carry zipBundle/format from the running state into the done state so
    // the popup can observe them via EXPORT_PROGRESS and know whether to
    // skip its client-side downloads.
    exportState = {
      status:    "done",
      step:      null,
      loaded:    shows.length,
      total:     shows.length,
      count:     shows.length,
      result,
      error:     null,
      format:    exportState.format,
      zipBundle: exportState.zipBundle,
      errors:    exportErrors.slice()
    };

    // ─── Download: ZIP bundle vs. separate HTML summary ──────────────────────
    // Use a base64 data URL (NOT a blob URL): blob URLs created in the SW
    // become invalid the moment the SW is suspended, breaking the download.
    const htmlDate    = new Date().toISOString().split('T')[0];
    const htmlContent = buildSummaryHtml(result.shows, result.movies, htmlDate);

    if (exportState.zipBundle) {
      // Collect every output file (JSON and/or CSV, plus the HTML summary)
      // into one JSZip, then trigger a single chrome.downloads.download call.
      // The popup observes state.zipBundle === true and skips its own
      // sequential downloads — see popup.js handleExportDone().
      try {
        const { files } = buildFilesList(result, exportState.format || "json");
        const JSZip = self.JSZip;
        if (typeof JSZip !== "function") {
          throw new Error("JSZip library failed to load");
        }
        const zip = new JSZip();
        for (const f of files) {
          zip.file(f.name, f.blob.content);
        }
        zip.file(`tvtime-summary-${htmlDate}.html`, htmlContent);

        // base64 output, not blob — blob URLs created from the SW become
        // invalid once the SW sleeps, which would silently break the download.
        const zipBase64 = await zip.generateAsync({ type: "base64" });
        await chrome.downloads.download({
          url:      `data:application/zip;base64,${zipBase64}`,
          filename: `tvtime-export-${htmlDate}.zip`,
          saveAs:   false
        });
      } catch (zipErr) {
        recordExportError(`ZIP bundling failed: ${zipErr.message ?? String(zipErr)}`);
        // Surface the failure to the popup so the user isn't left with no download.
        exportState = {
          status: "error",
          step:   null,
          loaded: exportState.loaded,
          total:  null,
          result: null,
          error:  `ZIP bundling failed: ${zipErr.message ?? String(zipErr)}`,
          format: exportState.format,
          zipBundle: exportState.zipBundle,
          errors: exportErrors.slice()
        };
      }
    } else {
      // Classic behaviour — download the HTML summary from the SW (survives
      // popup close); popup.js downloads the JSON/CSV files individually.
      const htmlBase64 = btoa(unescape(encodeURIComponent(htmlContent)));
      await chrome.downloads.download({
        url:      `data:text/html;base64,${htmlBase64}`,
        filename: `tvtime-summary-${htmlDate}.html`,
        saveAs:   false
      });
    }

  } catch (err) {
    // Cancellation unwinds the pipeline via a sentinel error — treat it as a
    // clean stop, not an error.
    if (err?.message === CANCEL_SENTINEL) {
      exportCancelled = false;
      exportState = {
        status: "cancelled",
        step:   null,
        stepIndex: 0,
        fetchCount: "",
        loaded: 0,
        total:  null,
        result: null,
        error:  null
      };
      console.log("[TVTO BG] Export cancelled by user.");
      return;
    }
    recordExportError(`Export aborted: ${err.message ?? String(err)}`);
    exportState = {
      status: "error",
      step:   null,
      loaded: exportState.loaded,
      total:  null,
      result: null,
      error:  err.message ?? String(err),
      errors: exportErrors.slice()
    };
  } finally {
    // Un-pin the tab whatever happened (success, error, cancel).
    try { await chrome.tabs.update(tabId, { autoDiscardable: true }); }
    catch (_) { /* tab closed — nothing to restore */ }
  }
}
