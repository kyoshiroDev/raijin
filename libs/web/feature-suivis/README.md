# web-feature-suivis

Écrans « Suivis » (`/suivis`) et « Alertes » (`/alertes`) de Raijin, chargés à la demande
(docs/ARCHITECTURE.md §11). Connexion et e-mail confirmé exigés (`verifiedEmailGuard`).

- `suivis/` : cartes empilées (< 768 px), grille 2 colonnes (≥ 768 px), tableau dense (≥ 1280 px) ;
  compteur des suivis actifs lu dans `PlanLimits`, pause / reprise, retrait avec confirmation.
- `alertes/` : historique paginé par curseur, filtres dans l'URL (`?statut=non-lues&type=…&mint=…`),
  bottom sheet < 1024 px et panneau latéral au-delà, `?alerte=<id>` (clic sur une notification push).
- `shared/format.ts` : phrases d'alerte factuelles et durées relatives.

Stores et clients HTTP : `@raijin/web-data-access` (`WatchesStore`, `AlertsStore`, `UnreadAlerts`).

`nx test web-feature-suivis` lance les tests Vitest.
