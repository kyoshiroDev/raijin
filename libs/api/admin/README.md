# api-admin

Espace admin de l'API (phase 6 bis, docs/ARCHITECTURE.md §14). Toutes les routes `admin/*` passent par
`@AdminRoute()` (`@raijin/api-auth`) : non-admin → 404, 2FA obligatoire, session admin 30 min / 8 h.

- `src/lib/users/**` (nestjs-api) : liste, recherche et fiche des comptes (auditées), actions avec confirmation, journal d'audit.
- le reste de `src/lib/**` (admin-analytics) : vue d'ensemble, trafic, SEO, acquisition, revenus, essais, produit, santé,
  agrégats `DailyMetric` et alertes admin.

Tests : `pnpm nx test api-admin`.
