/*
 * Raijin Shield — préchargement de l'analyse d'arrivée (docs/ARCHITECTURE.md §10.6, LCP de /analyse/<mint>).
 * Script classique, chargé en `async` dans <head> (CSP script-src 'self') : sur /analyse/<mint>, il demande le
 * jeton CSRF puis lance `POST /api/v1/analyses` ; sur /t/<mint>, il lit `GET /api/v1/analyses/<mint>/latest`. Le
 * tout dès la lecture du HTML, sans attendre le JavaScript d'Angular. L'app reprend ces promesses (`window.__rjStartup`, lu puis effacé par provideStartupPrefetch) :
 * une seule requête d'analyse, la même que l'écran aurait envoyée. Aucun stockage : le jeton reste en mémoire.
 * Tout échec est sans conséquence : l'app refait alors la requête normalement (refresh de session, maintenance).
 */
(() => {
  'use strict';
  const path = window.location.pathname;
  const match = /^\/(analyse|t)\/([^/?#]+)\/?$/.exec(path);
  if (!match || typeof window.fetch !== 'function') return;
  let mint;
  try {
    mint = decodeURIComponent(match[2]);
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
  if (match[1] === 't') {
    // Page publique : simple lecture (sans CSRF) de la dernière analyse publiée.
    const latest = window
      .fetch(`${base}/analyses/${encodeURIComponent(mint)}/latest`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      .then(json);
    latest.catch(() => undefined);
    window.__rjStartup = { kind: 'latest', mint, startedAt: Date.now(), latest };
    return;
  }

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
  window.__rjStartup = { kind: 'analyse', mint, startedAt: Date.now(), csrf, analysis };
})();
