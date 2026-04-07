/**
 * exporter.js — TV Time Out
 *
 * Télécharge le résultat complet de l'export en deux fichiers JSON
 * au format TV Time Liberator, espacés de 600 ms pour laisser le navigateur
 * ouvrir chaque boîte de dialogue de téléchargement.
 *
 * Usage :
 *   import { downloadAll } from "./exporter.js";
 *   downloadAll(result);   // result = { shows, movies }
 *
 * Fichiers produits :
 *   tvtime-series-{date}.json  — séries + animés avec saisons et épisodes intégrés
 *   tvtime-movies-{date}.json  — films avec statut de visionnage
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function toJsonBlob(data) {
  return new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/json;charset=utf-8;" }
  );
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCell(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  // Entourer de guillemets si la valeur contient virgule, guillemet ou saut de ligne
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsvBlob(rows) {
  const csv = rows.map(r => r.map(escapeCell).join(",")).join("\r\n");
  return new Blob([csv], { type: "text/csv;charset=utf-8;" });
}

function buildSeriesCsv(shows) {
  const header = ["uuid", "tvdb_id", "imdb_id", "title", "status", "created_at"];
  const rows   = shows.map(s => [
    s.uuid, s.id?.tvdb, s.id?.imdb, s.title, s.status, s.created_at
  ]);
  return toCsvBlob([header, ...rows]);
}

function buildEpisodesCsv(shows) {
  const header = [
    "show_uuid", "show_title", "season_number", "episode_number",
    "episode_tvdb_id", "is_special", "is_watched", "watched_at", "rewatch_count"
  ];
  const rows = [];
  for (const show of shows) {
    for (const season of (show.seasons ?? [])) {
      for (const ep of (season.episodes ?? [])) {
        rows.push([
          show.uuid, show.title, season.number, ep.number,
          ep.id?.tvdb, ep.special, ep.is_watched, ep.watched_at, ep.rewatch_count
        ]);
      }
    }
  }
  return toCsvBlob([header, ...rows]);
}

function buildMoviesCsv(movies) {
  const header = [
    "uuid", "tvdb_id", "imdb_id", "title", "created_at",
    "watched_at", "is_watched", "rewatch_count"
  ];
  const rows = movies.map(m => [
    m.uuid, m.id?.tvdb, m.id?.imdb, m.title, m.created_at,
    m.watched_at, m.is_watched, m.rewatch_count
  ]);
  return toCsvBlob([header, ...rows]);
}

function buildFailedCsv(failed) {
  const header = ["title", "tvdbId"];
  const rows   = failed.map(f => [f.title, f.tvdbId]);
  return toCsvBlob([header, ...rows]);
}

function buildListsCsv(lists) {
  const header = ["list_id", "list_name", "item_type", "tvdb_id", "uuid", "name", "custom_order"];
  const rows   = [];
  for (const list of lists) {
    for (const item of (list.items ?? [])) {
      rows.push([
        list.id,
        list.name,
        item.type,
        item.type === "series" ? item.tvdb_id : null,
        item.type === "movie"  ? item.uuid    : null,
        item.name,
        item.custom_order
      ]);
    }
  }
  return toCsvBlob([header, ...rows]);
}

// ---------------------------------------------------------------------------
// Export principal
// ---------------------------------------------------------------------------

/**
 * Télécharge les données selon le format choisi ("json" | "csv" | "both").
 *
 * @param {{ shows?: Array, movies?: Array, failedShows?: Array, failedMovies?: Array }} result
 * @param {"json"|"csv"|"both"} format
 */
export function downloadAll(result, format = "json") {
  const date  = new Date().toISOString().split("T")[0];
  const files = [];

  const wantJson = format === "json" || format === "both";
  const wantCsv  = format === "csv"  || format === "both";

  // ── JSON ──────────────────────────────────────────────────────────────────
  if (wantJson) {
    if (result.shows?.length)  files.push({ name: `tvtime-series-${date}.json`,  blob: toJsonBlob(result.shows) });
    if (result.movies?.length) files.push({ name: `tvtime-movies-${date}.json`,  blob: toJsonBlob(result.movies) });
    if (result.lists?.length)  files.push({ name: `tvtime-lists-${date}.json`,   blob: toJsonBlob(result.lists) });

    if (result.failedShows?.length > 0) {
      const report = {
        date,
        total_failed: result.failedShows.length,
        message: "These series could not be exported due to TV Time server timeout. Run the export again to retry.",
        shows: result.failedShows
      };
      files.push({ name: `tvtime-failed-${date}.json`, blob: toJsonBlob(report) });
    }

    if (result.failedMovies?.length > 0) {
      const report = {
        date,
        total_failed: result.failedMovies.length,
        message: "These movies could not be exported. Run the export again to retry.",
        movies: result.failedMovies
      };
      files.push({ name: `tvtime-failed-movies-${date}.json`, blob: toJsonBlob(report) });
    }
  }

  // ── CSV ───────────────────────────────────────────────────────────────────
  if (wantCsv) {
    if (result.shows?.length)  files.push({ name: `tvtime-series-${date}.csv`,   blob: buildSeriesCsv(result.shows) });
    if (result.shows?.length)  files.push({ name: `tvtime-episodes-${date}.csv`, blob: buildEpisodesCsv(result.shows) });
    if (result.movies?.length) files.push({ name: `tvtime-movies-${date}.csv`,   blob: buildMoviesCsv(result.movies) });
    if (result.lists?.length)  files.push({ name: `tvtime-lists-${date}.csv`,    blob: buildListsCsv(result.lists) });

    const allFailed = [
      ...(result.failedShows  ?? []),
      ...(result.failedMovies ?? [])
    ];
    if (allFailed.length > 0) {
      files.push({ name: `tvtime-failed-${date}.csv`, blob: buildFailedCsv(allFailed) });
    }
  }

  if (!files.length) throw new Error("Aucune donnée à télécharger.");

  files.forEach((f, i) => {
    setTimeout(() => triggerDownload(f.blob, f.name), i * 600);
  });
}
