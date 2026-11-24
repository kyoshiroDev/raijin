/*
 * Raijin Shield — préchargement de l'analyse d'arrivée (docs/ARCHITECTURE.md §10.6, LCP de /analyse/<mint>).
 * Script classique, chargé en `async` dans <head> (CSP script-src 'self') : sur /analyse/<mint> seulement, il
 * demande le jeton CSRF puis lance `POST /api/v1/analyses` dès la lecture du HTML, sans attendre le JavaScript
 * d'Angular. L'app reprend ces deux promesses (`window.__rjStartup`, lu puis effacé par provideStartupPrefetch) :
 * une seule requête d'analyse, la même que l'écran aurait envoyée. Aucun stockage : le jeton reste en mémoire.
 * Tout échec est sans conséquence : l'app refait alors la requête normalement (refresh de session, maintenance).
 */
(() => {
  'use strict';
  const match = /^\/analyse\/([^/?#]+)\/?$/.exec(window.location.pathname);
  if (!match || typeof window.fetch !== 'function') return;
  let mint;
  try {
    mint = decodeURIComponent(match[1]);
  } catch {
    return;
  }
  // Adresse base58 de 32 à 44 caractères (revalidée par l'app, `isSolanaAddress`).
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return;

  const base = '/api/v1';
  const json = (response) =>
    response.json().then(
      (body) => ({ status: response.status, body }),
      () => ({ status: response.status, body: null }),
    );
  const csrf = window
    .fetch(`${base}/auth/csrf`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(json)
    .then((result) => {
      const token = result.status === 200 && result.body ? result.body.csrfToken : null;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{32,256}$/.test(token)) throw new Error('csrf');
      return token;
    });
  const analysis = csrf.then((token) =>
    window
      .fetch(`${base}/analyses`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ input: mint }),
      })
      .then(json),
  );
  // Rejets observés ici : jamais d'« unhandled rejection », l'app relit chaque promesse.
  csrf.catch(() => undefined);
  analysis.catch(() => undefined);
  window.__rjStartup = { mint, startedAt: Date.now(), csrf, analysis };
})();
