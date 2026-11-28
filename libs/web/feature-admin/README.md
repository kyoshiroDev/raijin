# web-feature-admin

Espace admin de Raijin (`/admin`, chargé à la demande, Chart.js compris). PROMPT.md §4.7, docs/ARCHITECTURE.md §14.

## Propriété des dossiers (§14.1)

| Dossier | Agent |
| --- | --- |
| `src/lib/shell/**`, `src/lib/ui/**`, `src/lib/security/**`, `src/lib/lib.routes.ts`, `src/lib/testing/**` | ui-mobile-first |
| `src/lib/pages/**` (9 écrans) | admin-analytics |

## Brancher un écran

Dans `lib.routes.ts`, remplacer `loadComponent: placeholder, data: { screen: '…' }` de la ligne de l'écran par :

```ts
loadComponent: () => import('./pages/trafic/trafic.page').then((m) => m.TraficPage),
```

Titre et introduction de chaque écran : `ADMIN_SCREENS` (`shell/admin-screens.ts`, `adminScreen('trafic')`).
La coque n'affiche la page que si la session admin est vérifiée ; à l'expiration (403 `ADMIN_*` ou minuteur
d'inactivité), elle disparaît et l'utilisateur ressaisit son code. Les stores des écrans **doivent** se vider :

```ts
const session = inject(AdminSessionStore); // @raijin/web-data-access
session.onReset(() => this.data.set(null)); // ou lire session.epoch() dans un computed/effect
```

## Composants (`import { … } from '../../ui'`)

Mise en page type d'un écran :

```html
<div class="flex flex-col gap-6 md:gap-8">
  <rj-admin-page-header [title]="screen.title" [description]="screen.description">
    <rj-range-caption rjHeaderMeta [range]="report()?.range ?? null" />
    <rj-period-select [(period)]="period" />            <!-- 7 / 30 / 90 j ; [periods] pour 'today' -->
    <rj-admin-filters [activeCount]="1">…champs…</rj-admin-filters> <!-- bottom sheet < 1024 px -->
  </rj-admin-page-header>

  @if (loading()) { <rj-admin-page-skeleton [kpis]="4" /> }
  @else if (error()) { <rj-error-state (retry)="reload()" /> }          <!-- Rai alerte (web-ui) -->
  @else if (empty()) { <rj-empty-state title="…" /> }                    <!-- Rai bravo (web-ui) -->
  @else {
    <rj-kpi-grid [wide]="true">                                          <!-- 2 col. mobile, 3, puis 4 (5 si wide) -->
      @for (kpi of report().kpis; track kpi.key) { <rj-kpi-card [kpi]="kpi" comparisonLabel="vs 7 j préc." /> }
    </rj-kpi-grid>
    <rj-admin-panel title="Inscriptions" description="Par jour">
      <rj-chart type="line" title="Inscriptions par jour" [labels]="c.labels" [datasets]="c.datasets" />
    </rj-admin-panel>
  }
</div>
```

| Composant | Entrées principales |
| --- | --- |
| `rj-kpi-card` | `[kpi]` (`AdminKpi`) **ou** `label`, `value`, `unit` (`MetricUnit`), `change`, `previous`, `higherIsBetter`, `status`, `currency`, `comparisonLabel`. Variation = flèche + signe + %, phrase pour lecteurs d'écran ; « Nouveau » si précédent = 0 ; « Non connecté » / « Indisponible ». |
| `rj-kpi-grid` | `wide` (5 colonnes en xl). Lignes de même hauteur. |
| `rj-chart` | `type` (`line` / `bar` / `doughnut`), `title`, `labels`, `datasets: RjChartDataset[]` (`{ label, data, tone, tones? }`, tone `primary` = thunder, `comparison` = info pointillé, `safe|warn|danger` = verdicts), `unit`, `currency`, `horizontal` (entonnoir), `height` (`sm|md|lg`), `summary`, `categoryLabel`. Tableau « Voir les données » intégré. `timeSeriesToChart(series, { current, comparison })` convertit une `TimeSeries` du contrat. |
| `rj-data-table` | `caption`, `columns: RjTableColumn<T>[]` (`key`, `label`, `value`, `unit` ou `format`, `align`, `mono`, `primary`, `hideOnMobile`), `rows`, `trackBy`, `rowLink`, `emptyText`. Tableau ≥ 768 px, cartes en dessous. Textes externes affichés par interpolation. `rowLink` renvoie un chemin (`'/admin/sante'`) ou `{ path, queryParams }` (`{ path: '/admin/utilisateurs', queryParams: { fiche: id } }`) : **jamais** de `?` dans le chemin (encodé en `%3F` par le routeur → 404 ; une chaîne avec `?` est découpée par sécurité). |
| `rj-admin-panel` | `title`, `description`, `[rjPanelActions]`, `[rjPanelFooter]`. |
| `rj-admin-page-header` | `title`, `description`, `[rjHeaderMeta]`, outils projetés. |
| `rj-period-select` | `[(period)]`, `periods`. `rj-range-caption [range]` (`ResolvedRange`). |
| `rj-admin-filters` | `activeCount`, `title`, `description` ; contenu projeté (champs ≥ 16 px : classe `text-input`). |
| `rj-service-state` | `service` (`ga4` / `search_console`), `state` (`GoogleServiceState`), `variant` (`block` : « Non connecté » / erreur ; `inline` : « Données simulées », « Mis à jour à … »). |
| `rj-data-lag-notice` | `dataThrough`, `lagDays` (décalage Search Console). |
| `rj-admin-alert` | `tone` (`danger|warn|info|success`), icône + texte. |
| `rj-admin-page-skeleton` | `kpis`, `table`. |

Formatage : `formatMetric(value, unit, { currency, compact })`, `formatChange`, `formatDay`, `formatRange`,
`formatTime`. Icônes de l'admin : `AdminIcons` (Lucide, restent dans le chunk admin) passées à `<rj-icon [name]>`.
Démo de tous les composants : `/admin/demo` et `/_design/admin` (développement seulement).

Tests : `testing/harness.ts` (`setupAdmin()` monte la feature avec les vrais intercepteurs et une doublure de
Chart.js `RJ_CHART_LOADER`).
