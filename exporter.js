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

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
    "series_tvdb_id", "series_imdb_id", "series_uuid", "title",
    "season", "episode", "tvdb_id", "is_watched", "watched_at", "rewatch_count", "special"
  ];
  const rows = [];
  for (const show of shows) {
    for (const season of (show.seasons ?? [])) {
      for (const ep of (season.episodes ?? [])) {
        rows.push([
          show.id?.tvdb, show.id?.imdb, show.uuid, show.title,
          season.number, ep.number, ep.id?.tvdb, ep.is_watched, ep.watched_at, ep.rewatch_count, ep.special
        ]);
      }
    }
  }
  return toCsvBlob([header, ...rows]);
}

function buildMoviesCsv(movies) {
  const header = [
    "uuid", "tvdb_id", "imdb_id", "title", "year", "created_at",
    "watched_at", "is_watched", "rewatch_count"
  ];
  const rows = movies.map(m => [
    m.uuid, m.id?.tvdb, m.id?.imdb, m.title, m.year, m.created_at,
    m.watched_at, m.is_watched, m.rewatch_count
  ]);
  return toCsvBlob([header, ...rows]);
}

function buildFailedCsv(failed) {
  const header = ["title", "tvdbId"];
  const rows   = failed.map(f => [f.title, f.tvdbId]);
  return toCsvBlob([header, ...rows]);
}

function pad2(n) {
  return String(n ?? 0).padStart(2, "0");
}

function buildWatchedEpisodesCsv(shows) {
  const header = ["tvshow_title", "season", "episode", "season_episode", "watched_date"];
  const rows   = [];

  const sorted = [...shows].sort((a, b) =>
    (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" })
  );

  for (const show of sorted) {
    const eps = [];
    for (const season of (show.seasons ?? [])) {
      for (const ep of (season.episodes ?? [])) {
        if (!ep.is_watched) continue;
        eps.push({
          season:  season.number ?? 0,
          episode: ep.number     ?? 0,
          watched_date: ep.watched_at ?? ""
        });
      }
    }
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    for (const ep of eps) {
      rows.push([
        show.title,
        ep.season,
        ep.episode,
        `S${pad2(ep.season)}E${pad2(ep.episode)}`,
        ep.watched_date
      ]);
    }
  }

  return toCsvBlob([header, ...rows]);
}

function buildWatchedMoviesCsv(movies) {
  const header = ["film_title", "watched_date"];
  const rows   = [...movies]
    .filter(m => m.is_watched)
    .sort((a, b) =>
      (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" })
    )
    .map(m => [m.title, m.watched_at ?? ""]);
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
// HTML Summary
// ---------------------------------------------------------------------------

/**
 * Builds a self-contained HTML summary file from already-computed data.
 * No new API calls — uses the same shows/movies arrays produced by runExport.
 *
 * Shows table: JS-rendered, sortable by any column, filterable by title.
 * Sorted alphabetically by title on first load.
 * Shows with data-inconsistent episodes get a ▶ expand toggle.
 *
 * Episode flag rules:
 *   is_watched=true  & watched_at=null  → "watched but no date"
 *   is_watched=false & watched_at≠null  → "has date but not marked watched"
 *   is_watched=false & rewatch_count>0  → "rewatched but not marked watched"
 *
 * Row highlight logic (shows):
 *   green  — watched === total
 *   red    — status === "up_to_date" but watched < total
 *   orange — watched === 0 and status !== "not_started_yet"
 *
 * Movies table: static HTML, no sort/filter (unchanged behaviour).
 */
export function buildSummaryHtml(shows, movies, date) {
  const showList  = shows  ?? [];
  const movieList = movies ?? [];

  // ── Episode inconsistency detection ────────────────────────────────────────
  const _today = new Date();
  _today.setHours(0, 0, 0, 0);

  function getFlaggedEps(show) {
    const flagged = [];
    for (const season of (show.seasons ?? [])) {
      const isSeasonSpecial = (season.number ?? 0) === 0;
      for (const ep of (season.episodes ?? [])) {
        const isSpecial = isSeasonSpecial || ep.special === true;
        const issues = [];

        if ( ep.is_watched && !ep.watched_at)
          issues.push("Watched but no date");
        if (!ep.is_watched &&  ep.watched_at)
          issues.push("Has date but not marked watched");
        if (!ep.is_watched && (ep.rewatch_count ?? 0) > 0)
          issues.push("Rewatched but not marked watched");

        if (ep.watched_at) {
          const wd = new Date(ep.watched_at);
          if (!isNaN(wd) && wd > _today)
            issues.push("Future watch date");
        }

        if (ep.is_watched && ep.watched_at && ep.airDate) {
          const wd  = new Date(ep.watched_at);
          const air = new Date(ep.airDate);
          if (!isNaN(wd) && !isNaN(air) && wd < air)
            issues.push("Watched before air date");
        }

        if (issues.length) flagged.push({
          season:       season.number    ?? null,
          episode:      ep.number        ?? null,
          isSpecial,
          isWatched:    ep.is_watched    ?? false,
          watchedAt:    ep.watched_at    ?? null,
          rewatchCount: ep.rewatch_count ?? 0,
          issues
        });
      }
    }
    return flagged;
  }

  // ── Row class ──────────────────────────────────────────────────────────────
  function rowCls(status, watched, total) {
    if (total > 0 && watched === total)                return "row-green";
    if (status === "up_to_date" && watched < total)    return "row-red";
    if (watched === 0 && status !== "not_started_yet") return "row-orange";
    return "";
  }

  // ── Pre-compute show data (runs in extension context at export time) ────────
  const showData = showList.map(show => {
    // An episode is special if its season is 0 OR ep.special === true
    const allEpsTagged = (show.seasons ?? []).flatMap(s =>
      (s.episodes ?? []).map(ep => ({
        ...ep,
        _isSpecial: (s.number ?? 0) === 0 || ep.special === true,
        _seasonNum: s.number ?? 0
      }))
    );
    // Episodes tagged as special if season 0 OR ep.special === true
    // TBA filter: only exact "TBA" match (case-insensitive) — NOT empty/null names
    function isTba(e) {
      return (e.name ?? "").trim().toUpperCase() === "TBA";
    }

    const regularEps      = allEpsTagged.filter(e => !e._isSpecial);
    const specialEps      = allEpsTagged.filter(e =>  e._isSpecial);

    // total_regular and watched_regular exclude TBA placeholders
    const regularEpsNonTba = regularEps.filter(e => !isTba(e));
    const total            = regularEpsNonTba.length;
    const watched          = regularEpsNonTba.filter(e => e.is_watched).length;
    const pct              = total > 0 ? Math.round((watched / total) * 100) : 0;
    const totalSpecials    = specialEps.length;
    const watchedSpecials  = specialEps.filter(e => e.is_watched).length;
    const pctSpecials      = totalSpecials > 0 ? Math.round((watchedSpecials / totalSpecials) * 100) : 0;
    const tvdbId           = show.id?.tvdb  ?? null;
    const imdbId           = show.id?.imdb  ?? null;

    // Show-level flags
    const ghostEntry      = allEpsTagged.length === 0;
    const watchedWithDate = regularEpsNonTba.filter(e => e.is_watched && e.watched_at).length;
    const allMissingDates = watched > 0 && watchedWithDate === 0;

    // Unwatched non-TBA regular episodes (for inline Notes display)
    const unwatchedRegularEps = regularEpsNonTba
      .filter(e => !e.is_watched)
      .map(e => ({ season: e._seasonNum, episode: e.number ?? null }));


    return {
      title:              show.title  ?? "(unknown)",
      tvdbId,
      imdbId,
      status:             show.status ?? "",
      watched,
      total,
      pct,
      totalSpecials,
      watchedSpecials,
      pctSpecials,
      ghostEntry,
      allMissingDates,
      noEpisodeData:      show._noEpisodeData ?? false,
      unwatchedRegularEps,
      watchedNoDate:      regularEps.filter(e => e.is_watched && !e.watched_at).length,
      rowClass:           rowCls(show.status ?? "", watched, total),
      tvtHref:            tvdbId ? "https://app.tvtime.com/series/"   + tvdbId : null,
      tvdbHref:           tvdbId ? "https://www.thetvdb.com/series/" + tvdbId : null,
      imdbHref:           imdbId ? "https://www.imdb.com/title/"     + imdbId : null,
      flaggedEps:         getFlaggedEps(show)
    };
  });

  // Default sort: alphabetical by title (accent-insensitive, strip leading whitespace)
  showData.sort((a, b) => a.title.trim().localeCompare(b.title.trim(), undefined, { sensitivity: "base" }));

  const totalEpsWatched = showData.reduce((acc, r) => acc + r.watched + r.watchedSpecials, 0);

  // ── Summary statistics (shows only — movie stats computed after movieData) ──
  const totalRegularWatched     = showData.reduce((acc, s) => acc + s.watched, 0);
  const totalRegularNoDate      = showData.reduce((acc, s) => acc + s.watchedNoDate, 0);
  const totalRegularWithDate    = totalRegularWatched - totalRegularNoDate;
  const regularDatePct          = totalRegularWatched > 0 ? Math.round((totalRegularWithDate / totalRegularWatched) * 100) : 0;
  const totalSpecialsWatched    = showData.reduce((acc, s) => acc + s.watchedSpecials, 0);

  // ── Pre-compute movie data ─────────────────────────────────────────────────
  const movieData = movieList.map(movie => {
    const tvdbId = movie.id?.tvdb ?? null;
    const imdbId = movie.id?.imdb ?? null;
    const uuid   = movie.uuid     ?? null;
    return {
      title:        movie.title         ?? "(unknown)",
      tvdbId,
      imdbId,
      uuid,
      year:         movie.year          ?? null,
      isWatched:    movie.is_watched    ?? false,
      watchedAt:    movie.watched_at    ?? null,
      rewatchCount: movie.rewatch_count ?? 0,
      rowClass:     (movie.is_watched   ?? false) ? "row-green" : "",
      tvtHref:      uuid   ? "https://app.tvtime.com/movie/"    + uuid   : null,
      tvdbHref:     tvdbId ? "https://www.thetvdb.com/movies/"  + tvdbId : null,
      imdbHref:     imdbId ? "https://www.imdb.com/title/"      + imdbId : null
    };
  });

  // ── Summary statistics (movies) ───────────────────────────────────────────
  const totalMoviesWatched      = movieData.filter(m => m.isWatched).length;
  const totalMoviesWithDate     = movieData.filter(m => m.isWatched && m.watchedAt).length;
  const totalMoviesNoDate       = totalMoviesWatched - totalMoviesWithDate;
  const movieDatePct            = totalMoviesWatched > 0 ? Math.round((totalMoviesWithDate / totalMoviesWatched) * 100) : 0;

  // Movies table stays static HTML (sort/filter not requested for movies)
  const movieRowsHtml = movieData.map(movie => {
    const links = [
      movie.tvtHref  ? `<a href="${movie.tvtHref}"  target="_blank" rel="noopener">TV Time</a>` : "",
      movie.tvdbHref ? `<a href="${movie.tvdbHref}" target="_blank" rel="noopener">TVDB</a>`    : "",
      movie.imdbHref ? `<a href="${movie.imdbHref}" target="_blank" rel="noopener">IMDb</a>`    : "",
    ].filter(Boolean).join(" · ");
    const linksHtml    = links ? `<span class="links">${links}</span>` : "";
    const rewatchBadge = movie.rewatchCount > 0
      ? ` <span class="badge">${movie.rewatchCount}\u00D7</span>` : "";
    return `    <tr${movie.rowClass ? ` class="${movie.rowClass}"` : ""}>
      <td class="td-title">${escapeHtml(movie.title)}${movie.year ? `<span class="year-badge">(${movie.year})</span>` : ""}${linksHtml}</td>
      <td class="td-id">${movie.tvdbId != null ? escapeHtml(String(movie.tvdbId)) : '<span class="na">\u2014</span>'}</td>
      <td class="td-id">${movie.imdbId ? escapeHtml(movie.imdbId) : '<span class="na">\u2014</span>'}</td>
      <td class="td-status">${movie.isWatched ? "Yes" : "No"}</td>
      <td class="td-date">${movie.watchedAt ? escapeHtml(movie.watchedAt) : '<span class="na">\u2014</span>'}</td>
      <td class="td-rewatch">${movie.rewatchCount}${rewatchBadge}</td>
    </tr>`;
  }).join("\n");

  // Embed data — escape </ to prevent premature </script> tag close
  const showsJson  = JSON.stringify(showData).replace(/<\//g, "<\\/");
  const moviesJson = JSON.stringify(movieData).replace(/<\//g, "<\\/");

  // ── Full HTML document ─────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TV Time Out by Refract \u2014 Export Summary ${escapeHtml(date)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #1a1a1a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      padding: 24px 16px 48px;
    }

    /* ── Header ─────────────────────────────────────────────────────────── */
    .header {
      max-width: 1200px;
      margin: 0 auto 20px;
      border-bottom: 2px solid #f5c518;
      padding-bottom: 20px;
    }
    .header h1 { font-size: 22px; font-weight: 700; color: #f5c518; letter-spacing: .5px; margin-bottom: 16px; }
    .stats { display: flex; flex-wrap: wrap; gap: 12px 36px; margin-bottom: 20px; }
    .stat  { display: flex; flex-direction: column; gap: 2px; }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: #888; }
    .stat-value { font-size: 20px; font-weight: 700; color: #f5c518; }

    /* ── Data accuracy notice ────────────────────────────────────────────── */
    .notice {
      max-width: 1200px; margin: 0 auto 20px;
      background: rgba(107,45,139,.18); border: 1px solid #6b2d8b;
      border-left: 4px solid #6b2d8b; border-radius: 6px;
      padding: 12px 16px; font-size: 13px; color: #ccc; line-height: 1.6;
    }
    .notice strong { color: #c084fc; display: block; margin-bottom: 4px; font-size: 13px; }

    /* ── Summary statistics block ───────────────────────────────────────── */
    .summary-stats {
      max-width: 1200px; margin: 0 auto 20px;
      background: rgba(245,197,24,.06); border: 1px solid rgba(245,197,24,.25);
      border-left: 4px solid #f5c518; border-radius: 6px;
      padding: 12px 16px; font-size: 12px; color: #ccc; line-height: 1.8;
    }
    .summary-stats .ss-section { margin-bottom: 4px; }
    .summary-stats .ss-section:last-child { margin-bottom: 0; }
    .summary-stats .ss-label { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: #888; margin-right: 6px; }
    .summary-stats .ss-hi { color: #f5c518; font-weight: 600; }
    .summary-stats .ss-dim { color: #888; }

    /* ── Legend ─────────────────────────────────────────────────────────── */
    .legend {
      max-width: 1200px; margin: 0 auto 14px;
      display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: #aaa;
    }
    .legend-dot {
      display: inline-block; width: 10px; height: 10px;
      border-radius: 2px; margin-right: 5px; vertical-align: middle;
    }

    /* ── Section title ───────────────────────────────────────────────────── */
    .section-title {
      max-width: 1200px; margin: 0 auto 10px;
      font-size: 16px; font-weight: 600; color: #f5c518; padding-top: 8px;
    }

    /* ── Row number column ───────────────────────────────────────────────── */
    .th-num { width: 36px; text-align: right; color: #555; padding-right: 8px !important; }
    .td-num { width: 36px; text-align: right; color: #444; font-size: 11px; padding-right: 8px !important; white-space: nowrap; }

    /* ── Specials column ─────────────────────────────────────────────────── */
    .td-specials { white-space: nowrap; color: #c084fc; }
    .td-nodate   { white-space: nowrap; }
    .nodate-pos  { color: #f97316; font-weight: 600; }

    /* ── Per-column filter inputs (Excel-style) ──────────────────────────── */
    thead tr.filter-row th {
      padding: 4px 6px; background: #0c0c0c;
      border-bottom: 1px solid #2e2e2e; text-transform: none; letter-spacing: 0;
    }
    thead tr.filter-row th.th-num { padding: 4px 4px; }
    input.col-filter, select.col-filter {
      width: 100%; background: #111; border: 1px solid #252525; border-radius: 3px;
      color: #ccc; font-size: 11px; outline: none; padding: 3px 6px;
      font-family: inherit;
    }
    input.col-filter:focus, select.col-filter:focus { border-color: #6b2d8b; }
    input.col-filter::placeholder { color: #383838; }
    select.col-filter option { background: #1a1a1a; color: #ccc; }
    .filter-count { font-size: 12px; color: #666; margin-left: 6px; }

    /* ── Table ───────────────────────────────────────────────────────────── */
    .tbl-wrap {
      max-width: 1200px; margin: 0 auto 36px;
      overflow-x: auto; border-radius: 6px; border: 1px solid #2e2e2e;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead tr { background: #111; }
    th {
      padding: 9px 12px; text-align: left; font-size: 11px;
      text-transform: uppercase; letter-spacing: .7px; color: #777;
      border-bottom: 1px solid #2e2e2e; white-space: nowrap;
    }
    td { padding: 7px 12px; border-bottom: 1px solid #222; vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: rgba(255,255,255,.03); }

    /* ── Sortable column headers ─────────────────────────────────────────── */
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: #bbb; }
    th.sort-asc::after  { content: " \u25B2"; color: #f5c518; font-size: 9px; }
    th.sort-desc::after { content: " \u25BC"; color: #f5c518; font-size: 9px; }

    /* ── Column classes ──────────────────────────────────────────────────── */
    .td-title   { width: 220px; color: #fff; overflow: hidden; }
    .year-badge { font-size: 10px; color: #888; font-weight: 400; margin-left: 3px; white-space: nowrap; }
    .td-id      { font-size: 12px; color: #666; overflow: hidden; font-family: monospace; }
    .td-status  { color: #bbb; overflow: hidden; }
    .td-eps     { overflow: hidden; }
    .td-date    { font-size: 12px; color: #999; overflow: hidden; }
    .td-rewatch { text-align: center; }
    .na         { color: #444; }

    /* ── Links ───────────────────────────────────────────────────────────── */
    a { color: #f5c518; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .links { display: block; margin-top: 3px; font-size: 11px; }
    .links a { color: #f5c518; }
    .links a:hover { color: #c084fc; }

    /* ── Progress bar ────────────────────────────────────────────────────── */
    .bar-wrap {
      display: inline-block; vertical-align: middle;
      width: 72px; height: 4px; background: #2a2a2a;
      border-radius: 2px; margin-left: 8px; overflow: hidden;
    }
    .bar-fill { height: 100%; background: #f5c518; border-radius: 2px; }

    /* ── Expand toggle button ────────────────────────────────────────────── */
    .expand-btn {
      background: none; border: 1px solid #3a3a3a; border-radius: 3px;
      color: #777; cursor: pointer; font-size: 9px; line-height: 1;
      margin-left: 7px; padding: 2px 5px; vertical-align: middle;
      transition: border-color .15s, color .15s;
    }
    .expand-btn:hover { border-color: #f5c518; color: #f5c518; }

    /* ── Show-level flag badges (missing dates) ──────────────────────────── */
    .flag-badge {
      display: inline-block; margin-left: 6px; padding: 1px 6px;
      border-radius: 3px; font-size: 10px; font-weight: 600; vertical-align: middle;
    }
    .flag-nodate  { background: rgba(239,68,68,.15);  color: #f87171; }

    /* ── Rewatch badge ───────────────────────────────────────────────────── */
    .badge {
      display: inline-block; margin-left: 4px; padding: 1px 5px;
      background: rgba(107,45,139,.45); color: #c084fc;
      border-radius: 3px; font-size: 11px; font-weight: 600;
    }

    /* ── Row highlights ──────────────────────────────────────────────────── */
    tr.row-green      td { background: rgba( 34,197, 94,.09); }
    tr.row-red        td { background: rgba(239, 68, 68,.11); }
    tr.row-orange     td { background: rgba(249,115, 22,.09); }
    tr.row-green:hover  td { background: rgba( 34,197, 94,.16); }
    tr.row-red:hover    td { background: rgba(239, 68, 68,.18); }
    tr.row-orange:hover td { background: rgba(249,115, 22,.16); }

    /* ── Issues + Notes columns ──────────────────────────────────────────── */
    .td-issues { text-align: center; overflow: hidden; }
    .td-notes  { font-size: 11px; color: #888; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; overflow: hidden; }

    /* ── Failed to fetch section ─────────────────────────────────────────── */
    .failed-section {
      max-width: 1200px; margin: 0 auto 28px;
      background: rgba(239,68,68,.07);
      border: 1px solid rgba(239,68,68,.35);
      border-left: 4px solid #ef4444;
      border-radius: 6px; padding: 16px 20px;
    }
    .failed-section h2 {
      font-size: 14px; font-weight: 700; color: #f87171;
      margin-bottom: 10px; letter-spacing: .3px;
    }
    .failed-section p {
      font-size: 12px; color: #aaa; margin-bottom: 12px; line-height: 1.6;
    }
    .failed-list {
      list-style: none; display: flex; flex-direction: column; gap: 6px;
    }
    .failed-list li {
      font-size: 13px; color: #e0e0e0;
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    }
    .failed-list .f-title { color: #fff; font-weight: 500; }
    .failed-list .f-tvdb  { font-size: 11px; color: #666; font-family: monospace; }
    .failed-list .f-link  { font-size: 11px; color: #f5c518; }
    .failed-list .f-link:hover { color: #f87171; text-decoration: underline; }

    /* ── Footer ──────────────────────────────────────────────────────────── */
    .footer { max-width: 1200px; margin: 32px auto 0; font-size: 11px; color: #444; text-align: center; }
  </style>
</head>
<body>

  <div class="header">
    <h1>&#128250; <span style="color:#f5c518">TV TIME OUT</span> <span style="font-size:0.55em;color:#6b2d8b;letter-spacing:2px;vertical-align:middle;">BY REFRACT</span> \u2014 Export Summary</h1>
    <div class="stats">
      <div class="stat"><span class="stat-label">Export date</span><span class="stat-value">${escapeHtml(date)}</span></div>
      <div class="stat"><span class="stat-label">Shows</span><span class="stat-value">${showList.length.toLocaleString()}</span></div>
      <div class="stat"><span class="stat-label">Movies</span><span class="stat-value">${movieList.length.toLocaleString()}</span></div>
      <div class="stat"><span class="stat-label">Episodes watched</span><span class="stat-value">${totalEpsWatched.toLocaleString()}</span></div>
    </div>
  </div>

  <div class="notice">
    <strong>&#9888;&#65039; Data Accuracy Notice</strong>
    This export is based on TV Time's API and may contain inaccuracies due to known TV Time backend issues: orphaned watch records for shows you never watched, episodes marked as watched without a date, very old watches (pre-2017) that may not appear in the API, and ghost data that TV Time never cleaned up. Always cross-check outliers against your TV Time profile before importing elsewhere.
    Watch dates are stored in UTC by TV Time. If you notice some dates appearing 1 day off, this is expected — it happens when episodes were marked as watched late at night in your local timezone.
    Episode counts may include future unaired episodes that TV Time pre-creates in their database with real titles. This can cause "up-to-date but X episodes unwatched" warnings for continuing shows where the missing episodes haven't aired yet.
  </div>

  <div class="summary-stats">
    <div class="ss-section">
      <span class="ss-label">Shows</span>
      <span class="ss-hi">${showList.length.toLocaleString()}</span> total &nbsp;&middot;&nbsp;
      <span class="ss-hi">${totalRegularWatched.toLocaleString()}</span> regular episodes watched
      <span class="ss-dim">(${totalRegularWithDate.toLocaleString()} with date &nbsp;&middot;&nbsp; ${totalRegularNoDate.toLocaleString()} without date &nbsp;&middot;&nbsp; ${regularDatePct}% date coverage)</span>
      &nbsp;&middot;&nbsp; <span class="ss-hi">${totalSpecialsWatched.toLocaleString()}</span> specials watched
    </div>
    <div class="ss-section">
      <span class="ss-label">Movies</span>
      <span class="ss-hi">${totalMoviesWatched.toLocaleString()}</span> watched
      <span class="ss-dim">(${totalMoviesWithDate.toLocaleString()} with date &nbsp;&middot;&nbsp; ${totalMoviesNoDate.toLocaleString()} without date &nbsp;&middot;&nbsp; ${movieDatePct}% date coverage)</span>
    </div>
  </div>

  <div class="legend">
    <span><span class="legend-dot" style="background:rgba(34,197,94,.6)"></span>Fully caught up</span>
    <span><span class="legend-dot" style="background:rgba(239,68,68,.6)"></span>Marked up-to-date but missing episodes</span>
    <span><span class="legend-dot" style="background:rgba(249,115,22,.6)"></span>Following but 0 episodes watched</span>
    <span style="margin-left:8px; color:#6b2d8b">&#9654;</span><span style="color:#777; margin-left:4px">Episode data inconsistencies</span>
  </div>

  <p class="section-title">Shows &amp; Anime (<span id="filter-count">${showList.length.toLocaleString()}</span>)</p>

  <div class="tbl-wrap">
    <table id="shows-table">
      <thead id="shows-thead">
        <tr>
          <th class="th-num" style="width:36px">#</th>
          <th class="sortable sort-asc" data-sortcol="0" onclick="sortBy(0)" style="width:220px">Title</th>
          <th class="sortable" data-sortcol="1" onclick="sortBy(1)" style="width:80px">TVDB ID</th>
          <th class="sortable" data-sortcol="2" onclick="sortBy(2)" style="width:80px">IMDb ID</th>
          <th class="sortable" data-sortcol="4" onclick="sortBy(4)" style="width:110px">Status</th>
          <th class="sortable" data-sortcol="5" onclick="sortBy(5)" style="width:90px">Episodes</th>
          <th class="sortable" data-sortcol="6" onclick="sortBy(6)" style="width:80px">Specials</th>
          <th class="sortable" data-sortcol="10" onclick="sortBy(10)" style="width:70px">No Date</th>
          <th class="sortable" data-sortcol="8" onclick="sortBy(8)" style="width:55px">Issues</th>
          <th class="sortable" data-sortcol="9" onclick="sortBy(9)">Notes</th>
        </tr>
        <tr class="filter-row">
          <th class="th-num"></th>
          <th><input class="col-filter" type="search" placeholder="Title\u2026" autocomplete="off" oninput="setFilter(0,this.value)"></th>
          <th><input class="col-filter" type="search" placeholder="TVDB\u2026"  autocomplete="off" oninput="setFilter(1,this.value)"></th>
          <th><input class="col-filter" type="search" placeholder="IMDb\u2026"  autocomplete="off" oninput="setFilter(2,this.value)"></th>
          <th><select class="col-filter" onchange="setFilter(4,this.value)"><option value="">All</option><option value="up_to_date">up_to_date</option><option value="continuing">continuing</option><option value="stopped">stopped</option><option value="not_started_yet">not_started_yet</option><option value="unknown">unknown</option></select></th>
          <th></th>
          <th></th>
          <th><select class="col-filter" onchange="setFilter(8,this.value)"><option value="">All</option><option value="yes">Has missing dates</option><option value="no">No missing dates</option></select></th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody id="shows-tbody"></tbody>
    </table>
  </div>

  <p class="section-title">Movies (${movieList.length.toLocaleString()})</p>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th style="width:220px">Title</th>
          <th style="width:80px">TVDB ID</th>
          <th style="width:80px">IMDb ID</th>
          <th style="width:80px">Watched</th>
          <th style="width:120px">Watched date</th>
          <th style="width:80px">Rewatches</th>
        </tr>
      </thead>
      <tbody>
${movieRowsHtml}
      </tbody>
    </table>
  </div>

${(() => {
    const failedInHtml = showData.filter(s => s.noEpisodeData);
    if (!failedInHtml.length) return '';
    const items = failedInHtml.map(s => {
      const tvdbPart = s.tvdbId != null
        ? `<span class="f-tvdb">TVDB&nbsp;${escapeHtml(String(s.tvdbId))}</span>`
        : `<span class="f-tvdb">TVDB&nbsp;\u2014</span>`;
      const linkPart = s.tvtHref
        ? `<a class="f-link" href="${escapeHtml(s.tvtHref)}" target="_blank" rel="noopener">TV Time \u2197</a>`
        : '';
      return `    <li><span class="f-title">${escapeHtml(s.title)}</span>${tvdbPart}${linkPart}</li>`;
    }).join('\n');
    return `
  <div class="failed-section">
    <h2>&#10060; Failed to fetch episode details (${failedInHtml.length} show${failedInHtml.length > 1 ? 's' : ''})</h2>
    <p>These shows could not have their episode data retrieved from the TV DB after all retries. Their season and episode counts will be empty in the export files. Try running the export again to recover them.</p>
    <ul class="failed-list">
${items}
    </ul>
  </div>`;
  })()}

  <p class="footer">Generated by <strong style="color:#f5c518">TV Time Out</strong> \u00B7 ${escapeHtml(date)}</p>
  <p class="footer" style="margin-top:6px;">Have a suggestion or feedback? Share it with the <a href="https://getrefract.app/discord" target="_blank" style="color:#f5c518;text-decoration:none;">Refract community</a>!</p>

  <script>
    var SHOWS  = ${showsJson};
    var MOVIES = ${moviesJson};

    // ── Sort state — default: Issues desc (⚠️ first), then alphabetical within groups ──
    var _col = 8, _dir = 'desc';

    // ── Per-column filter state (index = sort col) ────────────────────────────
    var _filters = ['', '', '', '', '', '', '', '', ''];

    // ── HTML-escape helper for values inserted via innerHTML ─────────────────
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Comparator ───────────────────────────────────────────────────────────
    function cmp(a, b) {
      var va, vb, r;
      if (_col === 0) {
        // localeCompare with base sensitivity + strip leading whitespace
        r = a.title.trim().localeCompare(b.title.trim(), undefined, { sensitivity: 'base' });
        return _dir === 'asc' ? r : -r;
      }
      if      (_col === 1) { va = a.tvdbId != null ? Number(a.tvdbId) : Infinity;
                             vb = b.tvdbId != null ? Number(b.tvdbId) : Infinity; }
      else if (_col === 2) { va = (a.imdbId || '').trim().toLowerCase();
                             vb = (b.imdbId || '').trim().toLowerCase(); }
      else if (_col === 4) { va = (a.status || '').toLowerCase();
                             vb = (b.status || '').toLowerCase(); }
      else if (_col === 5) { va = a.pct;        vb = b.pct; }
      else if (_col === 6) { va = a.pctSpecials; vb = b.pctSpecials; }
      else if (_col === 8) {
        var _hasIssue = function(s) {
          return (s.flaggedEps && s.flaggedEps.length > 0) ||
                 (s.status === 'up_to_date' && s.total > 0 && s.watched < s.total) ||
                 (s.status === 'up_to_date' && s.watched === 0) ||
                 (s.watched > 0 && s.status === 'not_started_yet') ||
                 (s.watched === s.total && s.total > 0 && s.status === 'stopped');
        };
        va = _hasIssue(a) ? 1 : 0; vb = _hasIssue(b) ? 1 : 0;
      }
      else if (_col === 9) {
        r = computeNotes(a).localeCompare(computeNotes(b), undefined, { sensitivity: 'base' });
        return _dir === 'asc' ? r : -r;
      }
      else if (_col === 10) { va = a.watchedNoDate; vb = b.watchedNoDate; }
      else                 { va = a.pctSpecials; vb = b.pctSpecials; }
      // Empty / null values sort last in both directions
      var aEmpty = (va === '' || va === Infinity), bEmpty = (vb === '' || vb === Infinity);
      if (aEmpty && !bEmpty) return 1;
      if (!aEmpty && bEmpty) return -1;
      if (va < vb) return _dir === 'asc' ? -1 : 1;
      if (va > vb) return _dir === 'asc' ?  1 : -1;
      return 0;
    }

    // ── Per-column filter test ────────────────────────────────────────────────
    function isHidden(s) {
      if (_filters[0] && s.title.toLowerCase().indexOf(_filters[0]) === -1) return true;
      if (_filters[1] && String(s.tvdbId ?? '').indexOf(_filters[1]) === -1) return true;
      if (_filters[2] && (s.imdbId || '').toLowerCase().indexOf(_filters[2]) === -1) return true;
      if (_filters[4] && (s.status || '').toLowerCase().indexOf(_filters[4]) === -1) return true;
      if (_filters[5] && (s.watched + '\/' + s.total).indexOf(_filters[5]) === -1) return true;
      if (_filters[6] && (s.watchedSpecials + '\/' + s.totalSpecials).indexOf(_filters[6]) === -1) return true;
      if (_filters[8]) {
        var hasNoDate = s.watchedNoDate > 0;
        if (_filters[8] === 'yes' && !hasNoDate) return true;
        if (_filters[8] === 'no'  &&  hasNoDate) return true;
      }
      return false;
    }

    // ── Format a single episode as S01E04 ────────────────────────────────────
    function fmtEp(ep) {
      var s = ep.season  != null ? String(ep.season)  : '?';
      var e = ep.episode != null ? String(ep.episode) : '?';
      return 'S' + (s.length < 2 ? '0' + s : s) + 'E' + (e.length < 2 ? '0' + e : e);
    }

    // ── Human-readable notes — all details inline in Notes column ───────────
    function computeNotes(s) {
      var parts = [];

      // 1. Episode-level data inconsistencies — grouped by issue type with inline ep list
      if (s.flaggedEps && s.flaggedEps.length > 0) {
        var order = [
          'Watched but no date',
          'Has date but not marked watched',
          'Rewatched but not marked watched',
          'Future watch date',
          'Watched before air date'
        ];
        // Build a map: issue → [ep, ep, ...]
        var issueEps = {};
        for (var k = 0; k < s.flaggedEps.length; k++) {
          var ep = s.flaggedEps[k];
          for (var m = 0; m < ep.issues.length; m++) {
            var iss = ep.issues[m];
            if (!issueEps[iss]) issueEps[iss] = [];
            issueEps[iss].push(ep);
          }
        }
        for (var oi = 0; oi < order.length; oi++) {
          var key = order[oi];
          if (!issueEps[key]) continue;
          var epList = issueEps[key].map(fmtEp).join(' \u00b7 ');
          var label;
          if (key === 'Watched but no date') {
            var cnt = issueEps[key].length;
            label = cnt + ' episode' + (cnt > 1 ? 's' : '') + ' watched but no watch date';
          } else {
            label = key;
          }
          parts.push(label + ':<br>' + epList);
        }
      }

      // 2. Up-to-date but unwatched regular episodes — inline episode list
      // Uses the TBA-filtered list so future unaired placeholders don't trigger the warning
      var unwatchedCount = s.unwatchedRegularEps ? s.unwatchedRegularEps.length : 0;
      if (s.status === 'up_to_date' && unwatchedCount > 0) {
        var msg = 'Up-to-date but ' + unwatchedCount + ' regular episode' + (unwatchedCount > 1 ? 's' : '') + ' unwatched';
        msg += ':<br>' + s.unwatchedRegularEps.map(fmtEp).join(' \u00b7 ');
        parts.push(msg);
      }

      // 3. Other show-level notes
      if (s.noEpisodeData) {
        parts.push('No episode data available from TVDB after 3 retries');
      } else if (s.status === 'up_to_date' && s.watched === 0) {
        parts.push('Marked up-to-date but never watched');
      }
      if (s.watched > 0 && s.status === 'not_started_yet') {
        parts.push('Has watched episodes but marked as not started');
      }
      if (s.watched === s.total && s.total > 0 && s.status === 'stopped') {
        parts.push('All episodes watched but marked as stopped');
      }

      return parts.join(' \u00b7 ');
    }

    // ── Main render (shows table only) ───────────────────────────────────────
    function render() {
      var sorted  = SHOWS.slice().sort(cmp);
      var visNum  = 0;
      var html    = '';

      for (var i = 0; i < sorted.length; i++) {
        var s      = sorted[i];
        var hidden = isHidden(s);
        if (!hidden) visNum++;
        var dStyle = hidden ? ' style="display:none"' : '';
        var cls    = s.rowClass ? ' class="' + s.rowClass + '"' : '';

        // Links
        var lp = [];
        if (s.tvtHref)  lp.push('<a href="' + esc(s.tvtHref)  + '" target="_blank" rel="noopener">TV Time<\/a>');
        if (s.tvdbHref) lp.push('<a href="' + esc(s.tvdbHref) + '" target="_blank" rel="noopener">TVDB<\/a>');
        if (s.imdbHref) lp.push('<a href="' + esc(s.imdbHref) + '" target="_blank" rel="noopener">IMDb<\/a>');
        var links = lp.length ? '<span class="links">' + lp.join(' &middot; ') + '<\/span>' : '';

        // Progress bar (regular episodes only)
        var bar = '<div class="bar-wrap"><div class="bar-fill" style="width:' + s.pct + '%"><\/div><\/div>';

        // Show-level flag badges (episodes cell)
        var showBadges = '';
        if (s.allMissingDates) showBadges += ' <span class="flag-badge flag-nodate">no dates<\/span>';

        // Specials cell (purple, em-dash when none)
        var specialsCell = s.totalSpecials > 0
          ? s.watchedSpecials + '&thinsp;\/&thinsp;' + s.totalSpecials +
            '<div class="bar-wrap"><div class="bar-fill" style="width:' + s.pctSpecials + '%;background:#6b2d8b"><\/div><\/div>'
          : '<span class="na">\u2014<\/span>';

        // Issues cell: static ⚠️ when any issue exists, — when clean (no click)
        var hasAnyIssue = (s.flaggedEps && s.flaggedEps.length > 0) ||
                          (s.status === 'up_to_date' && s.total > 0 && s.watched < s.total) ||
                          (s.status === 'up_to_date' && s.watched === 0) ||
                          (s.watched > 0 && s.status === 'not_started_yet') ||
                          (s.watched === s.total && s.total > 0 && s.status === 'stopped');
        var issuesCell = hasAnyIssue ? '\u26a0\ufe0f' : '<span class="na">\u2014<\/span>';

        // Notes cell
        var notesText = computeNotes(s);

        html +=
          '<tr' + cls + dStyle + '>' +
          '<td class="td-num">'      + (hidden ? '' : visNum) + '<\/td>' +
          '<td class="td-title">'    + esc(s.title) + links + '<\/td>' +
          '<td class="td-id">'       + (s.tvdbId != null ? esc(String(s.tvdbId)) : '<span class="na">\u2014<\/span>') + '<\/td>' +
          '<td class="td-id">'       + (s.imdbId      ? esc(s.imdbId)            : '<span class="na">\u2014<\/span>') + '<\/td>' +
          '<td class="td-status">'   + esc(s.status) + '<\/td>' +
          '<td class="td-eps">'      + s.watched + '&thinsp;\/&thinsp;' + s.total + bar + showBadges + '<\/td>' +
          '<td class="td-specials">' + specialsCell + '<\/td>' +
          '<td class="td-nodate">'   + (s.watchedNoDate > 0 ? '<span class="nodate-pos">' + s.watchedNoDate + '<\/span>' : '<span class="na">\u2014<\/span>') + '<\/td>' +
          '<td class="td-issues">'   + issuesCell + '<\/td>' +
          '<td class="td-notes" title="' + esc(notesText.replace(/<br>/g, ' ')) + '">' + notesText + '<\/td>' +
          '<\/tr>';
      }

      document.getElementById('shows-tbody').innerHTML = html;
      // Update count in section title
      var anyFilter = _filters.some(function(f) { return f !== ''; });
      document.getElementById('filter-count').textContent =
        anyFilter ? (visNum + '\u00a0/\u00a0' + SHOWS.length) : SHOWS.length.toLocaleString();
      updateHeaders();
    }

    // ── Update sort-arrow classes on sortable column headers only ────────────
    function updateHeaders() {
      var ths = document.querySelectorAll('#shows-thead th[data-sortcol]');
      for (var i = 0; i < ths.length; i++) {
        var col = parseInt(ths[i].getAttribute('data-sortcol'), 10);
        ths[i].className = 'sortable' + (col === _col ? ' sort-' + _dir : '');
      }
    }

    // ── Column header click ───────────────────────────────────────────────────
    function sortBy(col) {
      if (_col === col) { _dir = _dir === 'asc' ? 'desc' : 'asc'; }
      else              { _col = col; _dir = 'asc'; }
      render();
    }

    // ── Per-column filter update ──────────────────────────────────────────────
    function setFilter(col, value) {
      _filters[col] = value.toLowerCase().trim();
      render();
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    render();
  <\/script>
</body>
</html>`;

  return html;
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
    if (result.shows?.length)  files.push({ name: `tvtime-series-episodes-${date}.csv`, blob: buildEpisodesCsv(result.shows) });
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
