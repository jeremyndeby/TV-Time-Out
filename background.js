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
  result:     null,     // { shows, movies } quand done
  error:      null
};

// ---------------------------------------------------------------------------
// Lecture des credentials depuis le storage persistant au démarrage
// ---------------------------------------------------------------------------
chrome.storage.session.get(["credentials"], (result) => {
  if (result.credentials) {
    cachedCredentials = result.credentials;
    console.log("[TVTO BG] Credentials restaurés depuis session storage.");
  }
});

// ---------------------------------------------------------------------------
// Listener principal
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log("[TVTO BG] Message reçu :", message.type);
  switch (message.type) {

    case "CREDENTIALS_FROM_PAGE": {
      const { userId, token } = message;
      console.log("[TVTO BG] CREDENTIALS_FROM_PAGE reçu :", { userId, token: !!token });
      if (userId && token) {
        const creds = { userId, token };
        cachedCredentials = creds;
        chrome.storage.session.set({ credentials: creds }, () => {
          console.log("[TVTO BG] Credentials stockés :", userId);
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
        console.log("[TVTO BG] GET_CREDENTIALS retourne :", !!data.credentials?.token);
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
      console.log("[TVTO BG] START_EXPORT userId :", userId, "token :", !!token);

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

        exportState = { status: "running", step: "Step 1/3: Fetching your shows…", stepIndex: 1, fetchCount: "", loaded: 0, total: null, result: null, error: null };
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
// Export 3 étapes :
//   1. Shows follows (series + anime)
//   2. Watch history (épisodes + films)
//   3. Détails saisons par série (api2.tozelabs.com)
//
// Films : follows/movie pour métadonnées (title, tvdb, imdb) + vus ET non vus
//         watches/movie pour watched_at — fusion par UUID
//
// Produit 2 fichiers au format TV Time Liberator : shows + movies.
// ---------------------------------------------------------------------------
async function runExport(userId, token, tabId) {
  const exportStartTime = Date.now();
  const cgwBase    = "https://msapi.tvtime.com/prod/v1/tracking/cgw/follows/user/" + userId;
  const watchesBase= "https://msapi.tvtime.com/prod/v1/tracking/watches/user/"     + userId;

  try {
    // -------------------------------------------------------------------------
    // Étape 1 — Séries + animés suivis
    // -------------------------------------------------------------------------
    exportState.step      = "Step 1/3: Fetching your shows…";
    exportState.stepIndex = 1;
    exportState.pct       = null;

    const seriesRaw = await fetchObjectsViaTab(tabId, cgwBase, "series", 1000);
    console.log(`[TVTO BG] Step 1a: ${seriesRaw.length} series`);

    const animeRaw = await fetchObjectsViaTab(tabId, cgwBase, "anime", 1000);
    console.log(`[TVTO BG] Step 1b: ${animeRaw.length} anime`);

    // Films — cgwBase retourne meta.name + meta.imdb_id + meta.external_sources + extended.is_watched
    const moviesRaw = await fetchObjectsViaTab(tabId, cgwBase, "movie", 1000);
    console.log(`[TVTO BG] Step 1c: ${moviesRaw.length} movies`);

    const showsRaw = [...seriesRaw, ...animeRaw];
    exportState.loaded     = showsRaw.length;
    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesRaw.length.toLocaleString()} movies fetched`;

    // -------------------------------------------------------------------------
    // Étape 2 — Historique de visionnage (épisodes + films)
    // Les watches films contiennent déjà toutes les métadonnées (title, id.tvdb, id.imdb)
    // -------------------------------------------------------------------------
    exportState.step      = "Step 2/3: Fetching watch history…";
    exportState.stepIndex = 2;

    const episodeWatches = await fetchObjectsViaTab(tabId, watchesBase, "episode", 99999);
    console.log(`[TVTO BG] Step 2a: ${episodeWatches.length} episode watches`);

    exportState.fetchCount = `${showsRaw.length.toLocaleString()} shows · ${moviesRaw.length.toLocaleString()} movies · ${episodeWatches.length.toLocaleString()} eps watches fetched`;

    // Index watched_at par episode_id — clés normalisées en String pour éviter type mismatch
    const watchedAtMap = new Map(
      episodeWatches.map(w => [String(w.episode_id), w.watched_at ?? null])
    );
    console.log("[TVTO] watchedAtMap size:", watchedAtMap.size);

    // -------------------------------------------------------------------------
    // Étape 3 — Détails saisons/épisodes par série
    // Batch parallèle de 5, timeout individuel (10s) + timeout batch (15s).
    // Pas de retry — évite les blocages du service worker MV3.
    // -------------------------------------------------------------------------
    exportState.step      = `Step 3/3: Fetching episode details… (0/${showsRaw.length})`;
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
        exportState.step = `Step 3/3: Fetching episode details… (${i + 1}/${showsNeedingSeasons.length})`;
      }
    }

    // Retry des séries échouées — jusqu'à 3 tentatives supplémentaires
    let retryList = failedShows
      .map(f => showsNeedingSeasons.find(s => s.tvdbId === f.tvdbId))
      .filter(Boolean);

    const MAX_RETRIES = 5;
    let attempt = 0;

    while (retryList.length > 0 && attempt < MAX_RETRIES) {
      attempt++;
      exportState.step = `⏳ Retrying ${retryList.length} failed series... (attempt ${attempt}/${MAX_RETRIES})`;
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
    }

    const finalFailed = retryList.map(s => ({ title: s.title, tvdbId: s.tvdbId }));
    console.warn("[seasons] Échecs finaux:", finalFailed.length, finalFailed);

    // -------------------------------------------------------------------------
    // Normalisation — Format TV Time Liberator
    // -------------------------------------------------------------------------

    // Séries + animés → { uuid, id, created_at, title, status, seasons[] }
    const shows = showsRaw.map(show => ({
      uuid:       show.uuid                           ?? null,
      id:         { tvdb: show.meta?.id ?? null, imdb: null },
      created_at: show.created_at                     ?? null,
      title:      show.meta?.name ?? show.meta?.title ?? null,
      status:     show.meta?.is_ended ? "ended" : "up_to_date",
      seasons:    (show.seasons ?? []).map(season => ({
        number:      season.number,
        is_specials: season.number === 0,
        episodes:    (season.episodes ?? []).map(ep => ({
          id:         { tvdb: ep.id ?? null, imdb: null },
          number:     ep.number,
          special:    ep.is_special ?? (season.number === 0),
          is_watched: ep.is_watched ?? false,
          watched_at: formatWatchedAt(watchedAtMap.get(String(ep.id?.tvdb ?? ep.id)))
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
        watched_at: m.watched_at ?? null,
        is_watched: m.extended?.is_watched ?? meta?.is_watched ?? false
      };
    });

    const failedMovies = movies
      .filter(m => m.title === null)
      .map(m => ({ uuid: m.uuid, title: null }));

    const result = { shows, movies, failedShows: finalFailed, failedMovies, durationMs: Date.now() - exportStartTime };

    exportState = {
      status: "done",
      step:   null,
      loaded: shows.length,
      total:  shows.length,
      count:  shows.length,
      result,
      error:  null
    };

    console.log(`[TVTO BG] Export terminé : ${shows.length} séries/animés, ${movies.length} films.`);

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
