/**
 * apiClient.js — TV Time Out
 *
 * Utilitaires purs (pas de fetch) :
 *   - Construction de l'URL sidecar confirmée en DevTools
 *   - Normalisation de la réponse vers le schéma standard
 *   - Helpers de pagination
 *
 * Le fetch lui-même est délégué à background.js via executeScript(world:'MAIN')
 * pour contourner la restriction CORS sur l'origine chrome-extension://.
 *
 * Endpoint confirmé :
 *   GET https://app.tvtime.com/sidecar
 *     ?o_b64=btoa("https://msapi.tvtime.com/prod/v1/tracking/cgw/follows/user/{userId}")
 *     &entity_type=series
 *     &filter=only_followed_series
 *
 * Headers requis :
 *   Authorization: Bearer {token}
 *   App-Version: 2025082201
 *   Client-Version: 10.10.0
 *   Country-Code: us
 *   Locale: en
 *   page-limit: 500      ← pagination dans le header
 *
 * Structure réponse :
 *   { data: { objects: [ { uuid, type, entity_type, created_at, updated_at, meta: { id, name, is_ended, ... } } ] } }
 *
 * Pagination :
 *   objects.length === PAGE_LIMIT → il y a une page suivante
 *   data.data.page_hash ou data.data.next_page → token de page suivante
 */

export const SIDECAR_BASE  = "https://app.tvtime.com/sidecar";
export const APP_VERSION   = "2025082201";
export const CLIENT_VERSION = "10.10.0";
export const PAGE_LIMIT    = 500;

// ---------------------------------------------------------------------------
// Construction d'URL
// ---------------------------------------------------------------------------

/**
 * Construit l'URL sidecar pour la liste des séries suivies.
 * La pagination se fait via header (page-limit) et page_hash, pas via l'URL.
 *
 * @param {string} userId
 * @returns {string}  URL sidecar complète
 */
export function buildSidecarUrl(userId) {
  const innerUrl = "https://msapi.tvtime.com/prod/v1/tracking/cgw/follows/user/" + userId;
  const o_b64    = btoa(innerUrl).replace(/=/g, ""); // padding supprimé — format attendu par l'API
  return SIDECAR_BASE + "?o_b64=" + o_b64 + "&entity_type=series&page_limit=1000";
}

// ---------------------------------------------------------------------------
// Parsing et pagination
// ---------------------------------------------------------------------------

/**
 * Extrait le tableau d'objets depuis la réponse API.
 * @param {object} data  Réponse JSON parsée
 * @returns {Array}
 */
export function extractObjects(data) {
  return data?.data?.objects ?? [];
}

/**
 * Retourne le token de page suivante, ou null s'il n'y en a pas.
 * @param {object} data  Réponse JSON parsée
 * @returns {string|null}
 */
export function getNextPageHash(data) {
  return data?.data?.page_hash ?? data?.data?.next_page ?? null;
}

/**
 * Indique s'il peut y avoir une page suivante (heuristique : batch plein).
 * @param {Array} batch
 * @returns {boolean}
 */
export function hasNextPage(batch) {
  return batch.length === PAGE_LIMIT;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Mappe un objet API vers le schéma standard TV Time Out.
 *
 * @param {object} obj  Objet brut depuis data.data.objects[]
 * @returns {{id, name, status, entity_type, created_at, updated_at}}
 */
export function normalizeShow(obj) {
  return {
    id:          obj.meta?.id                        ?? null,
    uuid:        obj.uuid                            ?? null,
    name:        obj.meta?.name ?? obj.meta?.title   ?? null,
    entity_type: obj.entity_type                     ?? null,
    status:      obj.meta?.is_ended ? "ended" : "continuing",
    created_at:  obj.created_at                      ?? null,
    updated_at:  obj.updated_at                      ?? null,
    tvdb_id:     obj.meta?.id                        ?? null,
    imdb_id:     obj.meta?.imdb_id                   ?? null
  };
}
