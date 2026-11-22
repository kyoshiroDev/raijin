import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { AnalysisCheckId, AnalysisResult } from '@raijin/shared-contracts';
import { RjAddressChip, RjBottomSheet, RjButton, RjCard, RjIcon, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { CHECK_HELP } from './check-help';
import { CHECK_STATUS_DISPLAY, statusCounts } from './check-display';
import { RjCheckItem } from './check-item';
import { RjFollowButton } from './follow-button';
import { ANALYSIS_CHECK_LABELS, ANALYSIS_DISCLAIMER, SAFE_VERDICT_REMINDER, VERDICT_LABELS } from './labels';
import { AnalysisShare, publicTokenUrl } from './share';

const VERDICT_TONES = {
  safe: 'border-safe/40 bg-safe/10 text-safe',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
} as const;

/** Formateur créé au premier usage (un `Intl.DateTimeFormat` coûte au chargement du module). */
let dateFormat: Intl.DateTimeFormat | null = null;
function formatDate(iso: string): string {
  dateFormat ??= new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return dateFormat.format(new Date(iso)).replace(/\u202f/g, '\u00a0');
}

/**
 * Résultat d'une analyse, partagé par l'écran d'analyse et la page publique `/t/<mint>`.
 * Mobile : verdict en grand, actions, puis les 9 contrôles en accordéons. Dès 1024 px :
 * verdict et résumé à gauche (collants), contrôles à droite. Le nom et le symbole du token
 * viennent de son créateur : marqués « non fiable », toujours rendus comme du texte.
 * Les actions de la page (appel à l'action jaune) sont projetées via `[rjResultActions]`.
 */
@Component({
  selector: 'rj-analysis-result',
  imports: [RjAddressChip, RjBottomSheet, RjButton, RjCard, RjCheckItem, RjFollowButton, RjIcon, RjSkeleton],
  template: `
    <div class="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      <section class="flex min-w-0 flex-col lg:sticky lg:top-20" aria-label="Verdict">
        <rj-card>
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-0.5">
              <p class="text-label font-medium tracking-wide text-ink-muted uppercase">Token analysé</p>
              <h2 class="flex min-w-0 flex-wrap items-baseline gap-x-2 font-display text-h3 text-ink">
                @if (name(); as name) {
                  <span class="min-w-0 wrap-anywhere" data-token-name>{{ name }}</span>
                  @if (symbol(); as symbol) {
                    <span class="shrink-0 font-sans text-body-sm font-medium text-ink-muted" data-token-symbol>{{ symbol }}</span>
                  }
                } @else {
                  <span class="text-ink-muted" data-token-name>Nom non publié</span>
                }
              </h2>
            </div>
            @if (name()) {
            <span
              class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line-strong px-2 py-0.5 text-label font-medium text-ink-muted"
              title="Nom et symbole déclarés par le créateur du token : Raijin ne peut pas les garantir."
            >
              <rj-icon name="info" [size]="16" />non fiable
              <span class="sr-only"> : nom et symbole déclarés par le créateur du token, non vérifiés</span>
            </span>
            }
          </div>

          <rj-address-chip [address]="result().mint" label="Adresse du token" [head]="6" [tail]="6" />

          <div [class]="'flex flex-col gap-3 rounded-md border p-4 ' + tone()" data-verdict-block>
            <div role="status" [attr.aria-label]="'Verdict : ' + verdictLabel()" class="flex items-center gap-3">
              <rj-icon [name]="result().verdict" [size]="32" />
              <span class="font-display text-h1">{{ verdictLabel() }}</span>
            </div>
            <p class="text-body text-ink" data-explanation>{{ result().explanation }}</p>
            @if (result().verdict === 'safe') {
              <p class="flex items-start gap-2 text-body-sm text-ink-muted">
                <rj-icon name="info" [size]="16" class="mt-0.5 shrink-0" />{{ safeReminder }}
              </p>
            }
          </div>

          @if (result().degraded) {
            <p class="flex items-start gap-2 rounded-md border border-line-strong bg-surface-raised p-3 text-body-sm text-ink" data-degraded>
              <rj-icon name="unavailable" [size]="16" class="mt-0.5 shrink-0 text-ink-muted" />
              <span>Résultat partiel : {{ unavailableText() }}, faute de source disponible. Réessaie dans quelques minutes.</span>
            </p>
          }

          <ul class="flex flex-wrap gap-x-4 gap-y-1" aria-label="Résumé des contrôles">
            @for (entry of counts(); track entry.status) {
              <li [class]="'inline-flex items-center gap-1.5 text-body-sm font-medium ' + statusDisplay[entry.status].text">
                <rj-icon [name]="statusDisplay[entry.status].icon" [size]="16" />
                <span class="tabular">{{ entry.count }}</span>
                <span>{{ statusDisplay[entry.status].label }}</span>
              </li>
            }
          </ul>

          <div rjCardFooter class="flex flex-col gap-4">
            <div [class]="actionsGrid()">
              @if (mode() === 'private') {
                <!-- Bouton « Suivre » (store des suivis, bottom sheets) chargé à l'inactivité : hors du
                     bundle initial et du chemin du LCP. Le placeholder garde la même taille. -->
                @defer (on idle) {
                  <rj-follow-button [mint]="result().mint" />
                } @placeholder {
                  <button type="button" rjButton="secondary" icon="follow" [disabled]="true">Suivre</button>
                }
              }
              <button
                type="button"
                rjButton="secondary"
                icon="share"
                [loading]="sharing()"
                (click)="share()"
              >
                Partager
              </button>
            </div>
            <ng-content select="[rjResultActions]" />
            <p class="flex items-start gap-1.5 text-label text-ink-muted">
              <rj-icon name="clock" [size]="16" class="shrink-0" />
              <span>Analysé le {{ analyzedAt() }}{{ result().cached ? ' (résultat en cache)' : '' }}</span>
            </p>
            <p class="text-label text-ink-muted" data-disclaimer>{{ disclaimer }}</p>
          </div>
        </rj-card>
      </section>

      <section class="min-w-0" aria-labelledby="rj-checks-title">
        <rj-card>
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="rj-checks-title" class="font-display text-h3 text-ink">Les 9 contrôles</h2>
            <p class="text-body-sm text-ink-muted">Touche un contrôle pour voir le détail.</p>
          </div>
          <!-- Verdict d'abord : les 9 contrôles sont rendus dans une tâche à part, à l'inactivité
               du navigateur (premier rendu plus court). Le placeholder reprend la hauteur des lignes. -->
          @defer (on idle) {
            <ul class="flex flex-col divide-y divide-line">
              @for (check of result().checks; track check.id) {
                <li>
                  <rj-check-item [check]="check" (learnMore)="openHelp(check.id)" />
                </li>
              }
            </ul>
          } @placeholder {
            <ul class="flex flex-col divide-y divide-line" aria-busy="true" aria-label="Chargement des contrôles" data-checks-placeholder>
              @for (check of result().checks; track check.id) {
                <li class="flex min-h-16 items-start gap-3 py-3">
                  <rj-skeleton shape="block" class="mt-0.5 size-9 shrink-0" />
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex h-6 items-center justify-between gap-2">
                      <rj-skeleton class="h-4 w-2/5" />
                      <rj-skeleton class="h-4 w-16" />
                    </span>
                    <span class="flex h-5 items-center"><rj-skeleton class="h-3 w-full" /></span>
                    <!-- Résumés sur deux lignes sur mobile, une seule dès 768 px (même hauteur que les lignes réelles). -->
                    <span class="flex h-5 items-center md:hidden"><rj-skeleton class="h-3 w-3/5" /></span>
                  </span>
                  <span class="mt-2 size-5 shrink-0"></span>
                </li>
              }
            </ul>
          }
        </rj-card>
      </section>
    </div>

    <rj-bottom-sheet [(open)]="helpOpen" [title]="helpTitle()" description="Comprendre ce contrôle en 30 secondes">
      @if (help(); as help) {
        <div class="flex flex-col gap-4 pb-2">
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Ce que c’est</h3>
            <p class="text-body text-ink-muted">{{ help.what }}</p>
          </section>
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Pourquoi c’est important</h3>
            <p class="text-body text-ink-muted">{{ help.why }}</p>
          </section>
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Comment Raijin le vérifie</h3>
            <p class="text-body text-ink-muted">{{ help.how }}</p>
          </section>
        </div>
      }
      <button rjSheetFooter type="button" rjButton="secondary" (click)="helpOpen.set(false)">J’ai compris</button>
    </rj-bottom-sheet>
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAnalysisResult {
  private readonly shareService = inject(AnalysisShare);
  private readonly toasts = inject(RjToastService);

  readonly result = input.required<AnalysisResult>();
  /** `private` : écran d'analyse (avec « Suivre ») ; `public` : page `/t/<mint>`. */
  readonly mode = input<'private' | 'public'>('private');

  protected readonly disclaimer = ANALYSIS_DISCLAIMER;
  protected readonly safeReminder = SAFE_VERDICT_REMINDER;
  protected readonly statusDisplay = CHECK_STATUS_DISPLAY;
  protected readonly sharing = signal(false);
  protected readonly helpOpen = signal(false);
  protected readonly helpId = signal<AnalysisCheckId | null>(null);

  /** Nom affiché (nom, sinon symbole) ; `null` si le créateur n'a rien publié. */
  protected readonly name = computed(() => {
    const { name, symbol } = this.result().token;
    return name || symbol || null;
  });
  protected readonly symbol = computed(() => {
    const { name, symbol } = this.result().token;
    return name && symbol ? symbol : null;
  });
  /** Boutons côte à côte s'ils tiennent en entier (colonne étroite entre 1024 et 1279 px : empilés). */
  protected readonly actionsGrid = computed(() =>
    this.mode() === 'private' ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2' : 'grid grid-cols-1 gap-2',
  );
  protected readonly verdictLabel = computed(() => VERDICT_LABELS[this.result().verdict]);
  protected readonly tone = computed(() => VERDICT_TONES[this.result().verdict]);
  protected readonly counts = computed(() => statusCounts(this.result().checks));
  protected readonly analyzedAt = computed(() => formatDate(this.result().analyzedAt));
  protected readonly unavailableText = computed(() => {
    const count = this.result().checks.filter((check) => check.status === 'unavailable').length;
    return count > 1 ? `${count} contrôles n’ont pas pu être vérifiés` : count === 1 ? '1 contrôle n’a pas pu être vérifié' : 'certaines données manquent';
  });
  protected readonly help = computed(() => {
    const id = this.helpId();
    return id ? CHECK_HELP[id] : null;
  });
  protected readonly helpTitle = computed(() => {
    const id = this.helpId();
    return id ? ANALYSIS_CHECK_LABELS[id] : 'En savoir plus';
  });

  protected openHelp(id: AnalysisCheckId): void {
    this.helpId.set(id);
    this.helpOpen.set(true);
  }

  protected async share(): Promise<void> {
    const result = this.result();
    this.sharing.set(true);
    const outcome = await this.shareService.share({
      title: `Verdict Raijin : ${this.verdictLabel()}`,
      text: `Raijin Shield a vérifié 9 points de sécurité de ce token : verdict ${this.verdictLabel()}. ${ANALYSIS_DISCLAIMER}`,
      url: publicTokenUrl(this.shareService.origin(), result.mint),
    });
    this.sharing.set(false);
    if (outcome === 'copied') {
      this.toasts.show('Lien de l’analyse copié.', { tone: 'success' });
    } else if (outcome === 'failed') {
      this.toasts.show('Copie impossible : copie le lien depuis la barre d’adresse.', { tone: 'error' });
    }
  }
}
