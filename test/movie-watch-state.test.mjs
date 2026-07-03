/**
 * Regression test for the "movies never marked watched" bug.
 *
 * The follows / movie-detail endpoints do NOT carry watch state; the movie
 * *watches* endpoint does. Watch state must be merged from the watches map by
 * uuid — mirroring how episode watch state is merged. Before the fix, every
 * exported movie came out is_watched:false / watched_at:null.
 *
 *   node test/movie-watch-state.test.mjs
 */
import { buildMovieWatchedMap, resolveMovieWatchState } from "../apiClient.js";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${msg}`); if (!cond) failures++; };

console.log("Movie watch-state merge\n");

// ── buildMovieWatchedMap ──────────────────────────────────────────────────────
const watches = [
  { uuid: "m-1", watched_at: "2024-01-21T00:33:46.403717Z", rewatch_count: 2 },
  { uuid: "m-2", watched_at: "2023-05-05T10:00:00Z", rewatch_count: 0 },
  { watched_at: "2020-01-01T00:00:00Z" }, // no uuid → skipped
];
const map = buildMovieWatchedMap(watches);
ok(map.size === 2, `map skips uuid-less rows (size ${map.size})`);
ok(map.get("m-1").rewatch_count === 2, "map keeps rewatch_count");

// ── resolveMovieWatchState — the bug: followed movie present in watches map ───
// A followed movie has NO is_watched flag anywhere on the raw object.
const followed = { uuid: "m-1", created_at: "x" };
const r1 = resolveMovieWatchState(followed, {}, map);
ok(r1.is_watched === true, "followed movie in watches map → is_watched=true (the bug)");
ok(r1.watched_at === "2024-01-21T00:33:46.403717Z", "watched_at taken from the watches map");
ok(r1.rewatch_count === 2, "rewatch_count taken from the watches map");

// Not watched: absent from map, no flag.
const r2 = resolveMovieWatchState({ uuid: "nope" }, {}, map);
ok(r2.is_watched === false && r2.watched_at === null && r2.rewatch_count === 0, "unwatched movie stays false/null/0");

// Fallback: legacy flag on meta still honoured when not in the map.
const r3 = resolveMovieWatchState({ uuid: "z" }, { is_watched: true }, map);
ok(r3.is_watched === true, "meta.is_watched fallback still respected");

// Watched but the record has no date → watched, date null (don't fabricate).
const map2 = buildMovieWatchedMap([{ uuid: "d", watched_at: null, rewatch_count: 0 }]);
const r4 = resolveMovieWatchState({ uuid: "d" }, {}, map2);
ok(r4.is_watched === true && r4.watched_at === null, "watched-without-date → is_watched=true, watched_at=null");

console.log(failures ? `\n❌ ${failures} FAILED` : "\n✅ ALL PASSED");
process.exit(failures ? 1 : 0);
