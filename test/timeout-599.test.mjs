/**
 * Verifies the 60s AbortController timeout on the episode-watches path:
 *   runExport Step 2 → fetchObjectsViaTab → fetchWithTimeout → fetch(signal)
 *
 * The code under test is extracted VERBATIM from the shipped background.js
 * (v1.2.20 @ e3fb74b). Only two numeric constants are scaled for test speed:
 *   SIDECAR_TIMEOUT_MS 60000 → 30 ms, retry backoff base 1000 → 1 ms.
 *
 * Simulated fetch NEVER resolves on its own; it only rejects with AbortError
 * when the AbortController fires — exactly like real fetch on a hung socket.
 */
import { readFileSync } from "fs";

const src = readFileSync(new URL("../background.js", import.meta.url), "utf8");

// ── extract the shipped functions verbatim ──────────────────────────────────
function extract(re, what) {
  const m = src.match(re);
  if (!m) { console.error(`✗ could not extract ${what}`); process.exit(1); }
  return m[0];
}
let code = [
  extract(/function describeHttpStatus\(status\) \{[\s\S]*?\n\}/, "describeHttpStatus"),
  extract(/let exportErrors = \[\];\nconst MAX_EXPORT_ERRORS[^\n]*\n/, "exportErrors"),
  extract(/function recordExportError\(msg\) \{[\s\S]*?\n\}/, "recordExportError"),
  extract(/let lastEntityStatus[^\n]*\n/, "lastEntityStatus"),
  extract(/const SIDECAR_TIMEOUT_MS = 60000;\nasync function fetchWithTimeout\([\s\S]*?\n\}/, "fetchWithTimeout"),
  extract(/async function fetchObjectsViaTab\(token, innerUrl, entityType, pageLimit, onPage = null\) \{[\s\S]*?\n  return allObjects;\n\}/, "fetchObjectsViaTab"),
].join("\n\n");

// scale timing constants (test speed only — logic untouched)
code = code
  .replace("const SIDECAR_TIMEOUT_MS = 60000;", "const SIDECAR_TIMEOUT_MS = 30;")
  .replace(/1000 \* Math\.pow\(2, attempt\)/g, "1 * Math.pow(2, attempt)")
  .replace("const delayMs = 1000 * Math.pow(2, attempt);", "const delayMs = 1;");
if (code.includes("60000")) { console.error("✗ timeout constant not scaled"); process.exit(1); }

// ── instrumented environment ────────────────────────────────────────────────
let fetchCalls = 0;
let abortsFired = 0;
globalThis.fetch = (url, opts) => {
  fetchCalls++;
  return new Promise((_resolve, reject) => {
    // never resolves; only the abort signal can end it — a hung connection
    opts.signal.addEventListener("abort", () => {
      abortsFired++;
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });
};
globalThis.btoa = s => Buffer.from(s).toString("base64");
const warns = [], errs = [];
console.warn  = (...a) => warns.push(a.join(" "));
console.error = (...a) => errs.push(a.join(" "));

const body = code + `
;globalThis.__test = { fetchObjectsViaTab, getErrors: () => exportErrors };`;
await import("data:text/javascript;base64," + Buffer.from(body).toString("base64"));
const { fetchObjectsViaTab, getErrors } = globalThis.__test;

// ── run: identical signature to runExport Step 2 ────────────────────────────
const t0 = Date.now();
const result = await fetchObjectsViaTab(
  "fake-token",
  "https://msapi.tvtime.com/prod/v1/tracking/watches/user/123",
  "episode",
  100
);
const ms = Date.now() - t0;

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${msg}`); if (!cond) failures++; };
const panel = getErrors();

console.log(`\nEpisode-watches timeout path (run took ${ms}ms, ${fetchCalls} fetches, ${abortsFired} aborts)\n`);
ok(abortsFired === fetchCalls, `every fetch was ended by the AbortController (${abortsFired}/${fetchCalls}) — timeout applies`);
ok(fetchCalls === 30, `attempts = 6 per page (1+5 retries) × 5 pages (MAX_CONSEC_FAILS) = 30, got ${fetchCalls}`);
ok(Array.isArray(result) && result.length === 0, "returns [] — export continues (skip-and-continue), no throw");
ok(warns.some(w => w.includes("HTTP 599") && w.includes("retry 1/5")), "synthetic 599 enters the existing 5xx retry loop");
ok(panel.length === 5, `one panel line per skipped page (5), got ${panel.length}`);
ok(panel.every(l => l.includes("episode page @") && l.includes("HTTP 599") && l.includes("skipping page")),
   "panel lines: 'episode page @N: HTTP 599 — exhausted 5 retries, skipping page'");
ok(panel.some(l => l.includes("@0")) && panel.some(l => l.includes("@400")),
   "pageOffset advanced between failed pages (@0 … @400) — pagination not stuck");

console.log(failures ? `\n❌ ${failures} FAILED` : "\n✅ ALL PASSED");
process.exit(failures ? 1 : 0);
