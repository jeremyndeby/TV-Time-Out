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
// Export principal
// ---------------------------------------------------------------------------

/**
 * Télécharge les données au format TV Time Liberator (2 fichiers).
 *
 * @param {{ shows?: Array, movies?: Array }} result
 */
export function downloadAll(result) {
  const date = new Date().toISOString().split("T")[0];

  const files = [
    { key: "shows",  name: `tvtime-series-${date}.json` },
    { key: "movies", name: `tvtime-movies-${date}.json` }
  ].filter(f => result[f.key]?.length);

  if (!files.length) throw new Error("Aucune donnée à télécharger.");

  files.forEach((f, i) => {
    setTimeout(() => {
      triggerDownload(toJsonBlob(result[f.key]), f.name);
    }, i * 600);
  });
}
