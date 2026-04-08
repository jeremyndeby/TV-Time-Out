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

import { buildSummaryHtml } from './exporter.js';

// ---------------------------------------------------------------------------
// État interne du service worker
// ---------------------------------------------------------------------------
let cachedCredentials = null; // { userId, token }
let exportState = {
  status:     "idle",   // "idle" | "running" | "done" | "error"
  step:       null,     // texte affiché dans le popup pendant "running"
  stepIndex:  0,        // 1 | 2 | 3 | 4 — pour la barre de progression
  fetchCount: "",       // ex: "676 shows · 28 movies fetched"
  loaded:     0,
  total:      null,
  result:     null,     // { shows, movies, lists } quand done
  error:      null
};

// ---------------------------------------------------------------------------
// Lecture des credentials depuis le storage persistant au démarrage
// ---------------------------------------------------------------------------
chrome.storage.session.get(["credentials"], (result) => {
  if (result.credentials) {
    cachedCredentials = result.credentials;
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

      chrome.tabs.query({ url: "https://app.tvtime.com/*" }, (tabs) => {
        if (!tabs?.length) {
          sendResponse({ ok: false, error: "Aucun onglet app.tvtime.com ouvert." });
          return;
        }

        exportState = { status: "running", step: "Step 1/4: Fetching your shows...", stepIndex: 1, fetchCount: "", loaded: 0, total: null, result: null, error: null };
        sendResponse({ ok: true });

        runExport(userId, token, tabs[0].id);
      });
      return true;
    }

    case "EXPORT_PROGRESS": {
      sendResponse({ ...exportState });
      return false;
    }

    case "RESET_EXPORT": {
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
async function fetchObjectsViaTab(tabId, innerUrl, entityType, pageLimit) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world:  "MAIN",
    func: async (innerUrl, entityType, pageLimit) => {
      const token   = localStorage.getItem("flutter.jwtToken")?.replace(/^"|"$/g, "");
      const o_b64   = btoa(innerUrl).replace(/=/g, "");
      const base    = "https://app.tvtime.com/sidecar?o_b64=" + o_b64 +
                      "&entity_type=" + entityType + "&page_limit=" + pageLimit;
      const headers = {
        "Authorization":  "Bearer " + token,
        "App-Version":    "2025082201",
        "Client-Version": "10.10.0"
      };

      const allObjects    = [];
      let   page          = 1;
      let   lastFirstUuid = null;

      while (true) {
        let data;
        try {
          const r = await fetch(base + "&page=" + page, { credentials: "include", headers });
          data = await r.json();
        } catch (e) {
          return { error: e.message };
        }

        const objects = data?.data?.objects ?? [];
        if (objects.length === 0) break;

        const firstUuid = objects[0]?.uuid;
        if (firstUuid && firstUuid === lastFirstUuid) break;

        allObjects.push(...objects);
        lastFirstUuid = firstUuid;

        if (objects.length < pageLimit) break;
        page++;
      }

      return { objects: allObjects };
    },
    args: [innerUrl, entityType, pageLimit]
  });

  const result = results?.[0]?.result;
  if (result?.error) throw new Error(result.error);
  return result?.objects ?? [];
}

// ---------------------------------------------------------------------------
// Polling : attend que window.__tvto_${tvdbId}_result soit défini dans la page,
// toutes les 200 ms, avec un timeout max de maxMs.
// Clé unique par tvdbId → appels parallèles sans collision.
// ---------------------------------------------------------------------------
async function waitForResult(tabId, tvdbId, maxMs = 55000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 200));
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   (id) => window[`__tvto_${id}_result`],
      args:   [tvdbId]
    });
    if (res?.[0]?.result !== undefined) return res[0].result;
  }
  return null; // timeout
}

// ---------------------------------------------------------------------------
// Fetch saisons d'une série via le sidecar TV Time (évite CORS).
// Encode l'URL api2.tozelabs.com en base64 pour la passer au sidecar.
// Clé unique par tvdbId → safe en parallèle (pas de collision window).
// ---------------------------------------------------------------------------
async function fetchSingleViaTab(tabId, tvdbId) {
  const innerUrl = `https://api2.tozelabs.com/v2/show/${tvdbId}/extended/seasons`;
  const o_b64    = btoa(innerUrl).replace(/=/g, "");
  const url      = `https://app.tvtime.com/sidecar?o_b64=${o_b64}`;

  // 1. Stocker l'URL et réinitialiser le slot résultat dans la page
  await chrome.scripting.executeScript({
    target: { tabId },
    world:  "MAIN",
    func:   (url, id) => {
      window[`__tvto_${id}_url`]    = url;
      window[`__tvto_${id}_result`] = undefined;
    },
    args:   [url, tvdbId]
  });

  // 2. Lancer le fetch depuis la page (token lu dans localStorage)
  await chrome.scripting.executeScript({
    target: { tabId },
    world:  "MAIN",
    func: (id) => {
      const token = localStorage.getItem("flutter.jwtToken")?.replace(/^"|"$/g, "");
      fetch(window[`__tvto_${id}_url`], {
        credentials: "include",
        headers: {
          "Authorization":  "Bearer " + token,
          "App-Version":    "2025082201",
          "Client-Version": "10.10.0"
        }
      })
      .then(r => r.json())
      .then(d => { window[`__tvto_${id}_result`] = d; })
      .catch(e => { window[`__tvto_${id}_result`] = { error: e.message }; });
    },
    args: [tvdbId]
  });

  // 3. Attendre la résolution via polling (200 ms × 40 max = 8 s)
  return waitForResult(tabId, tvdbId);
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
  return s.length >= 19 ? s.substring(0, 19) : null;
}

// ---------------------------------------------------------------------------
// Fetch les listes utilisateur via le sidecar TV Time.
// Endpoint : GET sidecar?o_b64=BASE64(msapi …/v2/lists/user/{userId}/lists)&expand=meta
// Retourne un tableau brut de listes (chacune avec objects[]).
// ---------------------------------------------------------------------------
async function fetchListsViaTab(tabId, userId) {
  const innerUrl   = `https://msapi.tvtime.com/prod/v2/lists/user/${userId}`;
  const b64        = btoa(innerUrl).replace(/=/g, "");
  const sidecarUrl = `https://app.tvtime.com/sidecar?o_b64=${b64}&expand=meta`;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world:  "MAIN",
    func: async (url) => {
      try {
        const decodedInner = atob(url.split("o_b64=")[1]?.split("&")[0] ?? "");
        console.error("[TVTO] lists sidecarUrl:", url);
        console.error("[TVTO] lists innerUrl decoded:", decodedInner);
        const token = localStorage.getItem("flutter.jwtToken")?.replace(/^"|"$/g, "");
        const r    = await fetch(url, {
          credentials: "include",
          headers: {
            "Authorization":  "Bearer " + token,
            "App-Version":    "2025082201",
            "Client-Version": "10.10.0"
          }
        });
        console.error("[TVTO] lists HTTP status:", r.status);
        const text = await r.text();
        console.error("[TVTO] lists raw response:", text.substring(0, 200));
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return { error: e.message, rawStart: text.slice(0, 150) };
        }
        return { data };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [sidecarUrl]
  });

  const result = results?.[0]?.result;
  if (result?.error) {
    if (result.rawStart !== undefined) {
      console.error("[TVTO] fetchListsViaTab JSON parse error:", result.error, "— raw start:", result.rawStart);
    }
    throw new Error(result.error);
  }
  const raw = result?.data;
  if (Array.isArray(raw))       return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

// ---------------------------------------------------------------------------
// Export 4 étapes :
//   1. Shows follows (series + anime)
//   2. Watch history (épisodes + films)
//   3. Détails saisons par série (api2.tozelabs.com)
//   4. Listes utilisateur (msapi.tvtime.com/prod/v2/lists)
//
// Films : follows/movie pour métadonnées (title, tvdb, imdb) + vus ET non vus
//         watches/movie pour watched_at — fusion par UUID
//
// Produit 3 fichiers au format TV Time Liberator : shows + movies + lists.
// ---------------------------------------------------------------------------
async function runExport(userId, token, tabId) {
  const exportStartTime = Date.now();
  const cgwBase    = "https://msapi.tvtime.com/prod/v1/tracking/cgw/follows/user/" + userId;
  const watchesBase= "https://msapi.tvtime.com/prod/v1/tracking/watches/user/"     + userId;

  try {
    // -------------------------------------------------------------------------
    // Étape 1 — Séries + animés suivis
    // -------------------------------------------------------------------------
    exportState.step      = "Step 1/4: Fetching your shows...";
    exportState.stepIndex = 1;
    exportState.pct       = null;

    const seriesRaw = await fetchObjectsViaTab(tabId, cgwBase, "series", 1000);
    const animeRaw = await fetchObjectsViaTab(tabId, cgwBase, "anime", 1000);


    // Films — cgwBase retourne meta.name + meta.imdb_id + meta.external_sources + extended.is_watched
    const moviesRaw = await fetchObjectsViaTab(tabId, cgwBase, "movie", 1000);

    const showsRaw = [...seriesRaw, ...animeRaw];
    exportState.loaded     = showsRaw.length;
    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesRaw.length.toLocaleString()} movies fetched`;

    // -------------------------------------------------------------------------
    // Étape 2 — Historique de visionnage (épisodes + films)
    // Les watches films contiennent déjà toutes les métadonnées (title, id.tvdb, id.imdb)
    // -------------------------------------------------------------------------
    exportState.step      = "Step 2/4: Fetching watch history...";
    exportState.stepIndex = 2;

    const episodeWatches = await fetchObjectsViaTab(tabId, watchesBase, "episode", 99999);

    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesRaw.length.toLocaleString()} movies · ${episodeWatches.length.toLocaleString()} eps fetched`;

    // Filter episode watches to only include episodes from followed shows.
    // This removes orphaned watch records for shows the user has unfollowed,
    // which would otherwise appear as ghost watched episodes in the export.
    const followedSeriesUuids = new Set(
      [...seriesRaw, ...animeRaw].map(s => s.uuid).filter(Boolean)
    );
    const filteredWatches = episodeWatches.filter(w => followedSeriesUuids.has(w.series_uuid));

    // Index watched_at — double clé (episode_id, uuid) pour couvrir tous les formats
    const watchedAtMap = new Map();
    filteredWatches.forEach(w => {
      const entry = { watched_at: w.watched_at ?? null, rewatch_count: w.rewatch_count ?? 0 };
      if (w.episode_id) watchedAtMap.set(String(w.episode_id), entry);
      if (w.uuid)       watchedAtMap.set(String(w.uuid),       entry);
    });

    // -------------------------------------------------------------------------
    // Étape 3 — Détails saisons/épisodes par série
    // Batch parallèle de 5, timeout individuel (10s) + timeout batch (15s).
    // Pas de retry — évite les blocages du service worker MV3.
    // -------------------------------------------------------------------------
    exportState.step      = `Step 3/4: Fetching episode details... (0/${showsRaw.length})`;
    exportState.stepIndex = 3;

    const BATCH_SIZE   = 3;
    const SHOW_TIMEOUT = 60000;
    const failedShows  = [];

    // Pré-calcul : liste plate des shows avec leur tvdbId et title
    const showsNeedingSeasons = showsRaw.map(show => ({
      tvdbId: show.meta?.id ?? null,
      title:  show.meta?.name ?? show.meta?.title ?? null,
      _ref:   show   // référence vers l'objet d'origine pour mutater show.seasons
    })).filter(s => s.tvdbId != null);

    // Shows sans tvdbId → seasons vide directement
    showsRaw.forEach(show => {
      if (!show.meta?.id) show.seasons = [];
    });

    for (let i = 0; i < showsNeedingSeasons.length; i += BATCH_SIZE) {
      const batch = showsNeedingSeasons.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(show =>
          Promise.race([
            fetchSingleViaTab(tabId, show.tvdbId),
            new Promise(r => setTimeout(() => r(null), SHOW_TIMEOUT))
          ])
        )
      );
      results.forEach((res, j) => {
        const show  = batch[j];
        const value = res.status === "fulfilled" ? res.value : null;
        show._ref.seasons = value?.seasons ?? value?.data?.seasons ?? [];
        if (!value) failedShows.push({ title: show.title, tvdbId: show.tvdbId });
      });
      if (i % 15 === 0) {
        const pct = 30 + Math.round((i / showsNeedingSeasons.length) * 70);
        exportState.pct  = pct;
        exportState.step = `Step 3/4: Fetching episode details... (${i + 1}/${showsNeedingSeasons.length})`;
      }
    }

    // Retry des séries échouées —
    // Au moins 50 tentatives garanties, puis arrêt si 10 rounds consécutifs sans amélioration.
    let retryList          = failedShows
      .map(f => showsNeedingSeasons.find(s => s.tvdbId === f.tvdbId))
      .filter(Boolean);

    let totalAttempts      = 0;
    let noImprovementCount = 0;
    let totalRecovered     = 0;

    while (retryList.length > 0) {
      const before = retryList.length;
      exportState.step = `⏳ Retrying ${before} failed series... (attempt ${totalAttempts + 1}, recovered ${totalRecovered} so far)`;

      const stillFailed = [];
      for (let i = 0; i < retryList.length; i += BATCH_SIZE) {
        const batch = retryList.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(show =>
            Promise.race([
              fetchSingleViaTab(tabId, show.tvdbId),
              new Promise(r => setTimeout(() => r(null), SHOW_TIMEOUT))
            ])
          )
        );
        results.forEach((res, j) => {
          const show  = batch[j];
          const value = res.status === "fulfilled" ? res.value : null;
          if (value) {
            show._ref.seasons = value?.seasons ?? value?.data?.seasons ?? [];
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

      if (totalAttempts >= 50 && noImprovementCount >= 10) break;
    }

    const finalFailed = retryList.map(s => ({ title: s.title, tvdbId: s.tvdbId }));

    // ── Retry shows that came back with 0 episodes — up to 3 attempts, 90s each ─
    // These shows fetched successfully but returned empty season data.
    // Each show is retried sequentially (up to 3 times), stopping on first success.
    // Shows that exhaust all retries are marked so the HTML summary can flag them.
    const RETRY_TIMEOUT  = 90000;
    const MAX_EP_RETRIES = 3;

    const zeroEpShows = showsNeedingSeasons.filter(show => {
      const seasons  = show._ref.seasons ?? [];
      const totalEps = seasons.reduce((sum, s) => sum + (s.episodes?.length ?? 0), 0);
      return seasons.length === 0 || totalEps === 0;
    });

    // Set to track shows that failed all 3 retries (keyed by tvdbId)
    const exhaustedRetries = new Set();

    if (zeroEpShows.length > 0) {
      exportState.step = `🔄 Retrying ${zeroEpShows.length} show(s) with no episode data (up to 3×90s)...`;

      for (const show of zeroEpShows) {
        let recovered = false;
        for (let attempt = 1; attempt <= MAX_EP_RETRIES; attempt++) {
          let value = null;
          try {
            value = await Promise.race([
              fetchSingleViaTab(tabId, show.tvdbId),
              new Promise(r => setTimeout(() => r(null), RETRY_TIMEOUT))
            ]);
          } catch (_) { value = null; }

          if (value) {
            const seasons  = value?.seasons ?? value?.data?.seasons ?? [];
            const totalEps = seasons.reduce((sum, s) => sum + (s.episodes?.length ?? 0), 0);
            if (totalEps > 0) {
              show._ref.seasons = seasons;
              recovered = true;
              break;
            }
          }
        }
        if (!recovered) exhaustedRetries.add(show.tvdbId);
      }
    }

    // -------------------------------------------------------------------------
    // Normalisation — Format TV Time Liberator
    // -------------------------------------------------------------------------

    // Séries + animés → { uuid, id, created_at, title, status, is_followed, seasons[] }
    const shows = showsRaw.map(show => ({
      uuid:             show.uuid                           ?? null,
      id:               { tvdb: show.meta?.id ?? null, imdb: null },
      created_at:       show.created_at                    ?? null,
      title:            show.meta?.name ?? show.meta?.title ?? null,
      status:           show.filter?.[1] ?? "unknown",
      is_followed:      show.type === 'follow',
      is_ended:         show.meta?.is_ended ?? false,
      _noEpisodeData:   exhaustedRetries.has(show.meta?.id ?? null),
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
          rewatch_count: watchedAtMap.get(String(ep.id?.tvdb ?? ep.id))?.rewatch_count ?? 0
        }))
      }))
    }));

    // Films — cgwBase source unique : métadonnées + statut vu + watched_at
    const movies = moviesRaw.map(m => {
      // Cherche les métadonnées dans les emplacements connus
      const meta       = m.meta ?? m.content ?? m.movie ?? m.data ?? m ?? {};
      const extSources = meta?.external_sources ?? [];
      const tvdbSource = extSources.find?.(s => s.source === "tvdb" || s.source === "TVDB");
      const tvdbId     = tvdbSource ? parseInt(tvdbSource.id) : (meta?.tvdb_id ?? meta?.id_tvdb ?? null);
      const imdbId     = meta?.imdb_id ?? meta?.id_imdb ?? null;
      const title      = meta?.name ?? meta?.title ?? meta?.original_name ?? null;
      return {
        id:         { tvdb: tvdbId, imdb: imdbId },
        uuid:       m.uuid,
        created_at: m.created_at,
        title,
        watched_at:    m.watched_at ?? null,
        is_watched:    m.extended?.is_watched ?? meta?.is_watched ?? false,
        rewatch_count: m.rewatch_count ?? 0
      };
    });

    const failedMovies = movies
      .filter(m => m.title === null)
      .map(m => ({ uuid: m.uuid, title: null }));

    // -------------------------------------------------------------------------
    // Étape 4 — Listes utilisateur
    // -------------------------------------------------------------------------
    exportState.step      = "Step 4/4: Fetching your lists...";
    exportState.stepIndex = 4;

    let listsRaw = [];
    try {
      listsRaw = await fetchListsViaTab(tabId, userId);
    } catch (listsErr) {
      console.error("[TVTO BG] fetchListsViaTab failed (non-fatal):", listsErr.message);
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

    const result = { shows, movies, lists, failedShows: finalFailed, failedMovies, durationMs: Date.now() - exportStartTime };

    exportState = {
      status: "done",
      step:   null,
      loaded: shows.length,
      total:  shows.length,
      count:  shows.length,
      result,
      error:  null
    };

    // Download HTML summary from background so it survives popup close
    const htmlDate    = new Date().toISOString().split('T')[0];
    const htmlContent = buildSummaryHtml(result.shows, result.movies, htmlDate);
    chrome.downloads.download({
      url:      'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent),
      filename: `tvtime-summary-${htmlDate}.html`,
      saveAs:   false
    });

  } catch (err) {
    exportState = {
      status: "error",
      step:   null,
      loaded: exportState.loaded,
      total:  null,
      result: null,
      error:  err.message ?? String(err)
    };
    console.error("[TVTO BG] Erreur export :", err);
  }
}