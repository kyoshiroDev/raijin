import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  WALLET_DELEGATION_EXPLANATION,
  WALLET_REVOKE_GUIDES,
  WALLET_REVOKE_GUIDE_URLS,
  type WalletDelegation,
  type WalletRevokeGuide,
} from '@raijin/shared-contracts';
import { RjAddressChip, RjIcon } from '@raijin/web-ui';
import { formatAmount, tokenLabel, tokenSymbol } from './format';

interface GuideGroup {
  readonly walletName: string;
  readonly guides: readonly WalletRevokeGuide[];
}

/**
 * Guides de révocation groupés par wallet. Seules les URLs exactes de la liste blanche des
 * contrats sont rendues (défense en profondeur si la liste était modifiée par erreur).
 */
export function revokeGuideGroups(guides: readonly WalletRevokeGuide[] = WALLET_REVOKE_GUIDES): GuideGroup[] {
  const groups = new Map<string, WalletRevokeGuide[]>();
  for (const guide of guides) {
    if (!WALLET_REVOKE_GUIDE_URLS.includes(guide.url) || !guide.url.startsWith('https://')) continue;
    const list = groups.get(guide.walletName) ?? [];
    list.push(guide);
    groups.set(guide.walletName, list);
  }
  return [...groups].map(([walletName, list]) => ({ walletName, guides: list }));
}

/**
 * Section « Délégations actives », affichée en tête du résultat quand le wallet en a : ce qu'est
 * une délégation, chaque délégation (token, délégué tronqué au milieu avec copie, montant délégué,
 * « tout le solde »), puis comment la révoquer **dans son propre wallet** (guides officiels
 * Phantom et Solflare). Raijin ne propose aucun bouton de révocation : ce serait une signature.
 */
@Component({
  selector: 'rj-wallet-delegations',
  imports: [RjAddressChip, RjIcon],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-warn/40 bg-surface p-4 md:gap-6 md:p-6" aria-labelledby="rj-delegations-title" data-delegations>
      <header class="flex items-start gap-3">
        <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-warn/40 bg-warn/10 text-warn">
          <rj-icon name="warn" [size]="20" />
        </span>
        <div class="flex min-w-0 flex-col gap-1">
          <h2 id="rj-delegations-title" class="font-display text-h3 text-ink">
            Délégations actives <span class="tabular text-ink-muted">({{ count() }})</span>
          </h2>
          <p class="text-body text-ink-muted">{{ explanation }}</p>
        </div>
      </header>

      <ul class="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4" aria-label="Délégations actives">
        @for (row of rows(); track row.delegation.tokenAccount) {
          <li class="flex h-full min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4" data-delegation>
            <div class="flex items-start justify-between gap-3">
              <h3 class="flex min-w-0 flex-col">
                <span class="truncate text-body font-semibold text-ink" [attr.title]="row.name">{{ row.name }}</span>
                @if (row.symbol; as symbol) {
                  <span class="truncate text-body-sm text-ink-muted">{{ symbol }}</span>
                }
              </h3>
              @if (row.delegation.coversFullBalance) {
                <span class="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-label font-semibold text-warn" data-full-balance>
                  <rj-icon name="warn" [size]="16" />Tout le solde
                </span>
              }
            </div>

            <div class="flex min-w-0 flex-col gap-1">
              <p class="text-label text-ink-muted">Adresse autorisée (délégué)</p>
              <rj-address-chip [address]="row.delegation.delegate" label="Adresse du délégué" [head]="6" [tail]="6" />
            </div>

            @if (row.note; as note) {
              <p class="text-body-sm text-ink-muted">{{ note }}</p>
            }
            <dl class="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3">
              <div class="flex min-w-0 flex-col gap-0.5">
                <dt class="text-label text-ink-muted">Montant délégué</dt>
                <dd class="tabular truncate text-body" [class.text-warn]="row.amount.unlimited" [class.text-ink]="!row.amount.unlimited" [attr.title]="row.amount.exact" data-delegated-amount>
                  {{ row.amount.short }}
                </dd>
              </div>
              <div class="flex min-w-0 flex-col gap-0.5">
                <dt class="text-label text-ink-muted">Solde du compte</dt>
                <dd class="tabular truncate text-body text-ink" [attr.title]="row.balance.exact">{{ row.balance.short }}</dd>
              </div>
            </dl>
          </li>
        }
      </ul>

      <div class="flex flex-col gap-4 rounded-md border border-line bg-base/40 p-4 md:p-5" data-revoke>
        <div class="flex flex-col gap-1">
          <h3 class="font-display text-h3 text-ink">Révoquer depuis ton wallet</h3>
          <p class="text-body-sm text-ink-muted">
            Raijin ne signe rien et ne propose aucun bouton de révocation : tu la fais toi-même, dans ton wallet. Ces guides officiels expliquent comment.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          @for (group of guides; track group.walletName) {
            <div class="flex min-w-0 flex-col gap-3">
              <h4 class="text-body font-semibold text-ink">{{ group.walletName }}</h4>
              @for (guide of group.guides; track guide.url) {
                <div class="flex flex-col gap-2">
                  @if (guide.steps.length > 1) {
                    <ol class="flex list-decimal flex-col gap-1 pl-5 text-body-sm text-ink-muted marker:text-ink-muted">
                      @for (step of guide.steps; track step) {
                        <li>{{ step }}</li>
                      }
                    </ol>
                  } @else {
                    <p class="text-body-sm text-ink-muted">{{ guide.steps[0] }}</p>
                  }
                  <a
                    [href]="guide.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="-my-1 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm text-body-sm font-medium text-info underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    data-revoke-link
                    >{{ guide.label }}<rj-icon name="external" [size]="16" class="shrink-0" /><span class="sr-only"> (nouvel onglet)</span></a
                  >
                </div>
              }
            </div>
          }
        </div>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjWalletDelegations {
  readonly delegations = input.required<readonly WalletDelegation[]>();
  /** Total compté par l'API (peut dépasser la liste affichée). */
  readonly total = input(0);

  protected readonly explanation = WALLET_DELEGATION_EXPLANATION;
  protected readonly guides = revokeGuideGroups();
  protected readonly count = computed(() => Math.max(this.total(), this.delegations().length));
  protected readonly rows = computed(() =>
    this.delegations().map((delegation) => {
      const symbol = delegation.token?.symbol ?? null;
      const empty = delegation.balance.raw === '0';
      return {
        delegation,
        name: tokenLabel(delegation.token, delegation.mint),
        symbol: tokenSymbol(delegation.token),
        amount: formatAmount(delegation.delegatedAmount, symbol),
        balance: formatAmount(delegation.balance, symbol),
        note: empty
          ? 'Compte vide : le délégué pourra agir dès que ce compte sera réalimenté.'
          : delegation.coversFullBalance
            ? 'Le délégué peut déplacer tout le solde de ce compte sans te redemander ton accord.'
            : null,
      };
    }),
  );
}
