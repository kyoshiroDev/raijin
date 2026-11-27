import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type MetricUnit } from '@raijin/shared-contracts';
import { RjIcon } from '@raijin/web-ui';
import { AdminIcons } from './admin-icons';
import { RjBreakText } from './break-text';
import { formatMetric } from './format';

/** Colonne de `rj-data-table`. Les textes sont affichés par interpolation (jamais en HTML) : données externes sûres. */
export interface RjTableColumn<T> {
  readonly key: string;
  readonly label: string;
  /** Valeur brute de la cellule. */
  readonly value: (row: T) => string | number | null | undefined;
  /** Unité d'une valeur numérique (formatée en fr-FR, chiffres mono alignés à droite). */
  readonly unit?: MetricUnit;
  /** Formatage libre (prioritaire sur `unit`). */
  readonly format?: (row: T) => string;
  readonly align?: 'start' | 'end';
  readonly mono?: boolean;
  /** Colonne titre des cartes mobiles (une seule ; la première colonne sinon). */
  readonly primary?: boolean;
  /** Repliée dans « Plus de détails » sur les cartes sous 768 px (détail secondaire, jamais perdu). */
  readonly hideOnMobile?: boolean;
}

interface Cell {
  readonly key: string;
  readonly label: string;
  readonly text: string;
  readonly end: boolean;
  readonly mono: boolean;
  readonly mobile: boolean;
}

/**
 * Cible d'une ligne cliquable : chemin seul, ou chemin + paramètres de requête (`?fiche=<id>`). Ne jamais mettre
 * la requête dans le chemin : `[routerLink]` l'encoderait (`%3F`) et mènerait à la page 404.
 */
export type RjRowLink = string | { readonly path: string; readonly queryParams?: Readonly<Record<string, string>> };

interface ResolvedLink {
  readonly path: string;
  readonly queryParams: Readonly<Record<string, string>> | null;
}

/**
 * Normalise une cible de ligne. Une chaîne qui contient `?` est découpée (filet de sécurité) : le chemin d'un
 * côté, les paramètres de requête de l'autre.
 */
export function resolveRowLink(link: RjRowLink | null): ResolvedLink | null {
  if (link === null) return null;
  if (typeof link !== 'string') return { path: link.path, queryParams: link.queryParams ?? null };
  const index = link.indexOf('?');
  if (index < 0) return { path: link, queryParams: null };
  const params = Object.fromEntries(new URLSearchParams(link.slice(index + 1)));
  return { path: link.slice(0, index), queryParams: Object.keys(params).length ? params : null };
}

interface Row {
  readonly id: string;
  readonly link: ResolvedLink | null;
  readonly primary: Cell;
  readonly cells: readonly Cell[];
  /** Colonnes `hideOnMobile` (hors titre), repliées dans « Plus de détails » sous 768 px. */
  readonly secondary: readonly Cell[];
}

/**
 * Tableau générique de l'admin, mobile first (PROMPT §3) :
 * - moins de 768 px : cartes empilées (colonne `primary` en titre, autres colonnes en paires libellé / valeur) ;
 *   les colonnes `hideOnMobile` restent consultables dans un repli natif « Plus de détails » ;
 * - de 768 à 1279 px : les mêmes cartes en grille de 2 colonnes, toutes les colonnes visibles ;
 * - à partir de 1280 px : tableau dense (chiffres alignés à droite), sans hauteur maximale (aucune ligne coupée :
 *   la pagination « Afficher plus » de l'écran limite la longueur), défilement horizontal seulement en dernier
 *   recours. Aucun texte tronqué : tout est renvoyé à la ligne, lisible sans survol ; la cellule titre (URL,
 *   e-mail) ne passe à la ligne qu'après ses séparateurs (`rj-break-text`).
 * `rowLink` rend la ligne cliquable (lien sur la cellule titre, cible ≥ 44 px) : `'/admin/x'` ou
 * `{ path: '/admin/utilisateurs', queryParams: { fiche: id } }`.
 *
 * `<rj-data-table caption="Pages les plus vues" [columns]="columns" [rows]="data.topPages" [trackBy]="byPath" />`
 */
@Component({
  selector: 'rj-data-table',
  imports: [RouterLink, RjIcon, RjBreakText],
  template: `
    @if (view().length === 0) {
      <p class="rounded-md border border-dashed border-line px-4 py-6 text-center text-body-sm text-ink-muted">{{ emptyText() }}</p>
    } @else {
      <!-- Région défilante (horizontalement, en dernier recours) atteignable au clavier et nommée : axe scrollable-region-focusable. -->
      <div
        class="hidden overflow-x-auto rounded-md border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring xl:block"
        role="region"
        tabindex="0"
        data-rj-table-region
        [attr.aria-label]="caption()"
      >
        <table class="w-full border-collapse text-left text-body-sm">
          <caption class="sr-only">{{ caption() }}</caption>
          <thead class="bg-surface-raised">
            <tr>
              @for (column of columns(); track column.key) {
                <th
                  scope="col"
                  class="border-b border-line px-3 py-2.5 align-bottom text-label font-semibold tracking-wide text-ink-muted uppercase"
                  [class.text-right]="isEnd(column)"
                >
                  {{ column.label }}
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of view(); track row.id) {
              <tr class="border-b border-line align-top transition-colors duration-150 ease-raijin last:border-b-0 hover:bg-surface-raised">
                @for (cell of row.cells; track cell.key; let first = $first) {
                  @if (first) {
                    <th scope="row" class="px-3 py-2.5 font-medium text-ink wrap-break-word" [class.text-right]="cell.end">
                      @if (row.link) {
                        <a [routerLink]="row.link.path" [queryParams]="row.link.queryParams" class="-my-2.5 flex min-h-11 items-center gap-1 rounded-sm hover:text-thunder-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">
                          <span class="min-w-0" [class.tabular]="cell.mono"><rj-break-text [text]="cell.text" /></span>
                        </a>
                      } @else {
                        <span class="block" [class.tabular]="cell.mono"><rj-break-text [text]="cell.text" /></span>
                      }
                    </th>
                  } @else {
                    <td class="px-3 py-2.5 text-ink wrap-break-word" [class.text-right]="cell.end" [class.tabular]="cell.mono">
                      {{ cell.text }}
                    </td>
                  }
                }
              </tr>
            }
          </tbody>
        </table>
      </div>

      <ul class="grid grid-cols-1 items-start gap-2 md:grid-cols-2 xl:hidden" data-rj-cards [attr.aria-label]="caption()">
        @for (row of view(); track row.id) {
          <li class="min-w-0 rounded-md border border-line bg-surface">
            @if (row.link) {
              <a
                [routerLink]="row.link.path"
                [queryParams]="row.link.queryParams"
                class="flex min-h-11 items-center gap-2 border-b border-line px-3 py-2.5 font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <span class="min-w-0 flex-1 wrap-break-word" data-rj-card-title [class.tabular]="row.primary.mono"><rj-break-text [text]="row.primary.text" /></span>
                <rj-icon [name]="chevron" [size]="16" class="text-ink-muted" />
              </a>
            } @else {
              <p class="border-b border-line px-3 py-2.5 font-medium text-ink wrap-break-word" data-rj-card-title [class.tabular]="row.primary.mono">
                <rj-break-text [text]="row.primary.text" />
              </p>
            }
            <dl class="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5">
              @for (cell of row.cells; track cell.key) {
                @if (cell.key !== row.primary.key) {
                  <div [class]="cell.mobile ? 'flex min-w-0 flex-col' : 'hidden min-w-0 flex-col md:flex'" [attr.data-rj-secondary]="cell.mobile ? null : ''">
                    <dt class="text-label text-ink-muted">{{ cell.label }}</dt>
                    <dd class="text-body-sm text-ink wrap-break-word" data-rj-card-value [class.tabular]="cell.mono">{{ cell.text }}</dd>
                  </div>
                }
              }
            </dl>
            @if (row.secondary.length > 0) {
              <!-- Colonnes secondaires repliées sous 768 px : jamais perdues, ouvertes d'un toucher. -->
              <details class="group border-t border-line md:hidden" data-rj-card-more>
                <summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-body-sm font-medium text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden">
                  <span>Plus de détails</span>
                  <rj-icon [name]="chevron" [size]="16" class="transition-transform duration-150 ease-raijin group-open:rotate-90" />
                </summary>
                <dl class="grid grid-cols-2 gap-x-3 gap-y-2 px-3 pb-2.5">
                  @for (cell of row.secondary; track cell.key) {
                    <div class="flex min-w-0 flex-col">
                      <dt class="text-label text-ink-muted">{{ cell.label }}</dt>
                      <dd class="text-body-sm text-ink wrap-break-word" data-rj-card-value [class.tabular]="cell.mono">{{ cell.text }}</dd>
                    </div>
                  }
                </dl>
              </details>
            }
          </li>
        }
      </ul>
    }
  `,
  host: { class: 'block min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjDataTable<T> {
  readonly caption = input.required<string>();
  readonly columns = input.required<readonly RjTableColumn<T>[]>();
  readonly rows = input.required<readonly T[]>();
  /** Identifiant stable d'une ligne (par défaut : son index). */
  readonly trackBy = input<(row: T, index: number) => string>((_row, index) => String(index));
  /** Lien vers le détail d'une ligne (`null` : ligne non cliquable). */
  readonly rowLink = input<((row: T) => RjRowLink | null) | null>(null);
  readonly emptyText = input('Aucune donnée sur cette période.');
  readonly currency = input('EUR');

  protected readonly chevron = AdminIcons.chevronRight;

  protected isEnd(column: RjTableColumn<T>): boolean {
    return column.align ? column.align === 'end' : column.unit !== undefined;
  }

  protected readonly view = computed<Row[]>(() => {
    const columns = this.columns();
    const track = this.trackBy();
    const link = this.rowLink();
    const currency = this.currency();
    const primaryKey = (columns.find((column) => column.primary) ?? columns[0])?.key;
    return this.rows().map((row, index) => {
      const cells = columns.map<Cell>((column) => {
        const raw = column.value(row);
        const text = column.format
          ? column.format(row)
          : typeof raw === 'number' && column.unit
            ? formatMetric(raw, column.unit, { currency })
            : raw === null || raw === undefined || raw === ''
              ? '—'
              : String(raw);
        return {
          key: column.key,
          label: column.label,
          text,
          end: this.isEnd(column),
          mono: column.mono ?? column.unit !== undefined,
          mobile: !column.hideOnMobile,
        };
      });
      const primary = cells.find((cell) => cell.key === primaryKey) ?? (cells[0] as Cell);
      const secondary = cells.filter((cell) => !cell.mobile && cell.key !== primary.key);
      return { id: track(row, index), link: link ? resolveRowLink(link(row)) : null, primary, cells, secondary };
    });
  });
}
