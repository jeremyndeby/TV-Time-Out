/**
 * content.js — TV Time Out
 *
 * S'exécute dans le contexte de la page app.tvtime.com.
 * Lit le localStorage Flutter pour extraire le token JWT et l'userId,
 * puis les envoie au service worker (background.js) via chrome.runtime.sendMessage.
 *
 * Exécuté à "document_idle" donc le localStorage est déjà disponible.
 */

(function extractAndSendCredentials() {
  "use strict";

  // ------------------------------------------------------------------
  // 1. Lecture du token JWT Flutter
  // ------------------------------------------------------------------
  const token = (localStorage.getItem("flutter.jwtToken") || "").replace(/^"|"$/g, "");

  // ------------------------------------------------------------------
  // 2. Lecture de l'userId Flutter
  // ------------------------------------------------------------------
  let userId = null;
  try {
    const raw = localStorage.getItem("flutter.user");
    if (raw) {
      const userObj = JSON.parse(raw);
      userId = userObj?.id ?? userObj?.user_id ?? null;
    }
  } catch (e) {
    console.warn("[TVTO] Impossible de parser flutter.user :", e);
  }

  // ------------------------------------------------------------------
  // 3. Validation
  // ------------------------------------------------------------------
  if (!token || !userId) {
    console.warn(
      "[TVTO] Credentials introuvables dans le localStorage.",
      { token: !!token, userId: !!userId }
    );
    return;
  }

  // ------------------------------------------------------------------
  // 4. Envoi au service worker
  // ------------------------------------------------------------------
  chrome.runtime.sendMessage(
    { type: "CREDENTIALS_FROM_PAGE", userId: String(userId), token },
    (response) => {
      if (chrome.runtime.lastError) {
        // Le service worker peut être endormi — c'est normal, on ignore
        return;
      }
      if (response?.ok) {
        console.log("[TVTO] Credentials envoyés avec succès.");
      } else {
        console.warn("[TVTO] Réponse inattendue :", response);
      }
    }
  );
})();

// ---------------------------------------------------------------------------
// Listener on-demand : le popup peut demander les credentials à tout moment,
// même si le service worker était endormi au chargement et a raté le sendMessage.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Lecture des credentials depuis le localStorage
  if (msg.type === "GET_CREDENTIALS") {
    const token = (localStorage.getItem("flutter.jwtToken") || "").replace(/^"|"$/g, "");
    let userId = null;
    try {
      const raw = localStorage.getItem("flutter.user");
      if (raw) {
        const obj = JSON.parse(raw);
        userId = obj?.id ?? obj?.user_id ?? null;
      }
    } catch (e) {}
    sendResponse({ token: token ?? null, userId: userId ? String(userId) : null });
    return true;
  }


});
