import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ADMIN_AUDIT_ACTION_LABELS,
  ADMIN_DESTRUCTIVE_ACTIONS,
  ADMIN_TRIAL_EXTENSION_MAX_DAYS,
  ADMIN_USER_ACTION_LABELS,
  ADMIN_USER_SEARCH_MIN_LENGTH,
  ADMIN_USER_STATUS_LABELS,
  ADMIN_USER_STATUSES,
  PLAN_LABELS,
  type AdminUserActionRequest,
  type AdminUserActionType,
  type AdminUserDetail,
  type AdminUserPage,
  type AdminUserSummary,
  type AuditLogEntry,
  type Plan,
  type TrialStatus,
} from '@raijin/shared-contracts';
import { AdminApi, createAdminReport, toClientError, type AdminUserListParams } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjIcon, RjInputField, RjToastService } from '@raijin/web-ui';
import { adminScreen } from '../../shell/admin-screens';
import { RjAdminAlert } from '../../ui/alert';
import { NO_VALUE, RjAdminFilters, RjAdminPageHeader, RjAdminPanel, RjDataTable, formatLongDay, formatMetric, type RjRowLink, type RjTableColumn } from '../../ui';
import { RjAdminReportState } from '../shared/page-helpers';

const TRIAL_LABELS: Readonly<Record<TrialStatus, string>> = { none: 'Jamais', active: 'En cours', ended: 'Terminé', ineligible: 'Non éligible' };
const SOURCE_LABELS: Readonly<Record<AdminUserSummary['planSource'], string>> = { free: 'Gratuit', trial: 'Essai', subscription: 'Abonnement', gift: 'Pro offert' };
const SUBSCRIPTION_STATUS_TEXT: Readonly<Record<string, string>> = {
  trialing: 'en essai Stripe',
  active: 'actif',
  past_due: 'paiement en retard',
  canceled: 'résilié',
  incomplete: 'incomplet',
  incomplete_expired: 'expiré',
  unpaid: 'impayé',
  paused: 'en pause',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Effet de chaque action, résumé avant l'envoi. */
const ACTION_EFFECTS: Readonly<Record<AdminUserActionType, string>> = {
  extend_trial: 'L’essai Pro est prolongé du nombre de jours choisi (ou rouvert s’il est terminé sans abonnement).',
  grant_pro_month: 'Le compte passe en Pro pour 30 jours de plus, sans paiement (365 jours d’avance au plus).',
  suspend: 'Toutes les sessions sont fermées, la connexion est refusée, les alertes et e-mails s’arrêtent. L’abonnement Stripe n’est pas résilié.',
  reactivate: 'Le compte peut de nouveau se connecter ; alertes et e-mails reprennent.',
  resend_verification: 'Un nouvel e-mail de vérification part vers l’adresse du compte.',
  delete: 'Le compte et ses données sont supprimés définitivement (abonnement résilié). Le journal d’audit est conservé sans e-mail.',
};

const dateTime = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : NO_VALUE);

/**
 * Écran 7 — Utilisateurs (routes de nestjs-api) : recherche par e-mail (3 caractères au moins, auditée), liste
 * filtrable (plan, essai, statut, source, date d'inscription) en cartes sur mobile, fiche en panneau (bottom sheet
 * sur mobile) avec lien Stripe, usage, suivis, attribution et journal. Actions confirmées et auditées ; suspendre et
 * supprimer exigent de recopier l'e-mail, supprimer exige un code TOTP. **Aucune usurpation de compte.**
 */
@Component({
  selector: 'rj-admin-users-page',
  imports: [RjAdminPageHeader, RjAdminFilters, RjAdminPanel, RjDataTable, RjAdminReportState, RjBottomSheet, RjButton, RjIcon, RjInputField, RjAdminAlert],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description" />
      <div class="flex min-w-0 flex-wrap items-end gap-3">
        <form class="flex w-full min-w-0 items-start gap-2 lg:w-96" role="search" (submit)="search($event)">
          <rj-input-field class="min-w-0 flex-1" label="Recherche par e-mail" type="search" inputmode="email" enterkeyhint="search" [(value)]="searchText" [error]="searchError()" hint="3 caractères au moins" />
          <button type="submit" rjButton="secondary" icon="filter" class="mt-7 shrink-0">Chercher</button>
        </form>
        <rj-admin-filters title="Filtrer les comptes" [activeCount]="activeFilters()">
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Plan</span>
            <select [class]="selectClass" (change)="setFilter('plan', $event)">
              <option value="" [selected]="!filters().plan">Tous</option>
              @for (plan of plans; track plan) {
                <option [value]="plan" [selected]="filters().plan === plan">{{ planLabels[plan] }}</option>
              }
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Essai</span>
            <select [class]="selectClass" (change)="setFilter('trialStatus', $event)">
              <option value="" [selected]="!filters().trialStatus">Tous</option>
              @for (status of trialStatuses; track status) {
                <option [value]="status" [selected]="filters().trialStatus === status">{{ trialLabels[status] }}</option>
              }
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Statut</span>
            <select [class]="selectClass" (change)="setFilter('status', $event)">
              <option value="" [selected]="!filters().status">Tous</option>
              @for (status of statuses; track status) {
                <option [value]="status" [selected]="filters().status === status">{{ statusLabels[status] }}</option>
              }
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Source UTM</span>
            <input [class]="selectClass" type="text" maxlength="100" [value]="filters().source ?? ''" (change)="setFilter('source', $event)" />
            <!-- Indication dans le libellé (pas d'id : le contenu des filtres est rendu deux fois, bureau et bottom sheet). -->
            <span class="text-label text-ink-muted wrap-break-word" data-filter-hint>« (direct) » pour les comptes sans source</span>
          </label>
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Inscrit depuis</span>
            <input [class]="selectClass" type="date" [value]="filters().signupFrom ?? ''" (change)="setFilter('signupFrom', $event)" />
          </label>
          <label class="flex min-w-0 flex-col gap-1 lg:w-44">
            <span class="text-label font-semibold text-ink-muted">Inscrit jusqu’au</span>
            <input [class]="selectClass" type="date" [value]="filters().signupTo ?? ''" (change)="setFilter('signupTo', $event)" />
          </label>
        </rj-admin-filters>
      </div>

      <rj-admin-report-state [report]="list" [kpis]="0" (retry)="reload()">
        @if (list.data(); as page) {
          <rj-admin-panel [title]="count(page.total) + (page.total > 1 ? ' comptes' : ' compte')" description="Les plus récents d’abord. Ouvrir une fiche est journalisé.">
            <rj-data-table caption="Comptes" [columns]="columns" [rows]="page.items" [trackBy]="byId" [rowLink]="link" emptyText="Aucun compte ne correspond." />
            @if (page.nextCursor) {
              <div rjPanelFooter class="flex justify-center">
                <button type="button" rjButton="secondary" [loading]="loadingMore()" (click)="more(page)">Afficher plus</button>
              </div>
            }
          </rj-admin-panel>
        }
      </rj-admin-report-state>
    </div>

    <rj-bottom-sheet [open]="selectedId() !== null" (openChange)="$event || closeDetail()" [title]="detail.data()?.email ?? 'Fiche utilisateur'" description="Données personnelles : consultation journalisée" desktop="panel">
      @if (detail.data(); as user) {
        <div class="flex flex-col gap-5 pb-2">
          @if (user.suspendedAt) {
            <rj-admin-alert tone="warn">Compte suspendu depuis le {{ day(user.suspendedAt) }}.@if (user.subscription) { L’abonnement Stripe continue : à résilier dans Stripe si besoin. }</rj-admin-alert>
          }
          <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
            <div><dt class="text-label text-ink-muted">Plan</dt><dd class="text-body text-ink">{{ planLabels[user.plan] }}@if (user.planSource !== 'free') { ({{ sourceLabels[user.planSource] }}) }</dd></div>
            <div><dt class="text-label text-ink-muted">Statut</dt><dd class="text-body text-ink">{{ statusLabels[user.status] }}</dd></div>
            <div><dt class="text-label text-ink-muted">Essai</dt><dd class="text-body text-ink">{{ trialText(user) }}</dd></div>
            <div><dt class="text-label text-ink-muted">Abonnement</dt><dd class="text-body text-ink">{{ subscriptionText(user) }}</dd></div>
            @if (user.giftEndsAt) {
              <div><dt class="text-label text-ink-muted">Pro offert</dt><dd class="text-body text-ink">jusqu’au {{ day(user.giftEndsAt) }}</dd></div>
            }
            <div><dt class="text-label text-ink-muted">Inscription</dt><dd class="tabular text-body text-ink">{{ dateTime(user.createdAt) }}</dd></div>
            <div><dt class="text-label text-ink-muted">Dernière connexion</dt><dd class="tabular text-body text-ink">{{ dateTime(user.lastLoginAt) }}</dd></div>
            <div><dt class="text-label text-ink-muted">E-mail vérifié</dt><dd class="text-body text-ink">{{ user.emailVerified ? 'Oui' : 'Non' }}</dd></div>
          </dl>
          @if (user.stripeDashboardUrl; as stripe) {
            <a rjButton="secondary" icon="external" [href]="stripe" target="_blank" rel="noopener noreferrer">{{ stripe.includes('/test/') ? 'Ouvrir dans le dashboard Stripe (mode test)' : 'Ouvrir dans le dashboard Stripe' }}</a>
          }

          <section class="flex flex-col gap-2">
            <h3 class="font-display text-body font-semibold text-ink">Usage (30 jours)</h3>
            <dl class="grid grid-cols-2 gap-2 md:grid-cols-3">
              @for (item of usage(user); track item.label) {
                <div class="rounded-md border border-line bg-surface-raised p-2">
                  <dt class="text-label text-ink-muted">{{ item.label }}</dt>
                  <dd class="tabular text-body font-semibold text-ink">{{ item.value }}</dd>
                </div>
              }
            </dl>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="font-display text-body font-semibold text-ink">Attribution</h3>
            <dl class="grid grid-cols-1 gap-1 text-body-sm sm:grid-cols-2">
              @for (item of attribution(user); track item.label) {
                <div class="flex min-w-0 gap-2"><dt class="shrink-0 text-ink-muted">{{ item.label }}</dt><dd class="min-w-0 text-ink wrap-anywhere">{{ item.value }}</dd></div>
              }
            </dl>
          </section>

          @if (user.availableActions.length > 0) {
            <section class="flex flex-col gap-2">
              <h3 class="font-display text-body font-semibold text-ink">Actions</h3>
              <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                @for (action of user.availableActions; track action) {
                  <button type="button" [rjButton]="action === 'delete' ? 'danger' : 'secondary'" (click)="startAction(action)">{{ actionLabels[action] }}</button>
                }
              </div>
            </section>
          } @else {
            <p class="text-body-sm text-ink-muted">Aucune action possible sur ce compte (compte admin ou ton propre compte).</p>
          }

          <section class="flex flex-col gap-2">
            <h3 class="font-display text-body font-semibold text-ink">Journal</h3>
            @for (entry of user.audit; track entry.id) {
              <div class="flex flex-col gap-0.5 border-b border-line pb-2 last:border-b-0">
                <span class="text-body-sm text-ink">{{ auditLabel(entry) }}</span>
                <span class="text-label text-ink-muted">{{ dateTime(entry.createdAt) }} · {{ actorText(entry) }}@if (entry.metadata.reason) { · motif : {{ entry.metadata.reason }} }</span>
              </div>
            } @empty {
              <p class="text-body-sm text-ink-muted">Aucune entrée.</p>
            }
          </section>
        </div>
      } @else if (detail.status() === 'error') {
        <rj-admin-alert>Fiche introuvable ou indisponible.</rj-admin-alert>
      } @else {
        <p role="status" class="flex items-center gap-2 py-6 text-body-sm text-ink-muted"><rj-icon name="loader" [spin]="true" [size]="16" />Chargement de la fiche…</p>
      }
    </rj-bottom-sheet>

    <rj-bottom-sheet [open]="pendingAction() !== null" (openChange)="$event || cancelAction()" [title]="pendingAction() ? actionLabels[pendingAction()!] : 'Action'" [description]="pendingAction() ? effects[pendingAction()!] : ''">
      @if (pendingAction(); as action) {
        <form id="rj-admin-action" class="flex flex-col gap-4 pb-2" (submit)="confirm($event)">
          @if (action === 'extend_trial') {
            <label class="flex flex-col gap-1">
              <span class="text-label font-semibold text-ink-muted">Jours ajoutés (1 à {{ maxDays }})</span>
              <input [class]="selectClass" type="number" min="1" [max]="maxDays" [value]="days()" (input)="days.set(+$any($event.target).value)" />
            </label>
          }
          @if (action !== 'resend_verification') {
            <label class="flex flex-col gap-1">
              <span class="text-label font-semibold text-ink-muted">Motif (journalisé)</span>
              <textarea class="min-h-20 rounded-md border border-line-strong bg-surface p-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" maxlength="500" [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea>
            </label>
          }
          @if (destructive(action)) {
            <rj-input-field label="Recopie l’e-mail du compte pour confirmer" type="email" autocomplete="off" [(value)]="confirmEmail" [hint]="detail.data()?.email ?? ''" />
          }
          @if (action === 'delete') {
            <rj-input-field label="Code de ton application d’authentification" inputmode="numeric" autocomplete="one-time-code" [maxlength]="6" [mono]="true" [(value)]="totpCode" />
          }
          @if (actionError(); as message) {
            <rj-admin-alert>{{ message }}</rj-admin-alert>
          }
        </form>
      }
      <button rjSheetFooter type="button" rjButton="ghost" (click)="cancelAction()">Annuler</button>
      <button rjSheetFooter type="submit" form="rj-admin-action" [rjButton]="pendingAction() === 'delete' ? 'danger' : 'primary'" [loading]="submitting()" [disabled]="!canConfirm()">Confirmer</button>
    </rj-bottom-sheet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminUsersPage {
  private readonly api = inject(AdminApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(RjToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly screen = adminScreen('utilisateurs');
  protected readonly plans: readonly Plan[] = ['FREE', 'PRO'];
  protected readonly trialStatuses: readonly TrialStatus[] = ['none', 'active', 'ended', 'ineligible'];
  protected readonly statuses = ADMIN_USER_STATUSES;
  protected readonly planLabels = PLAN_LABELS;
  protected readonly trialLabels = TRIAL_LABELS;
  protected readonly statusLabels = ADMIN_USER_STATUS_LABELS;
  protected readonly sourceLabels = SOURCE_LABELS;
  protected readonly actionLabels = ADMIN_USER_ACTION_LABELS;
  protected readonly effects = ACTION_EFFECTS;
  protected readonly maxDays = ADMIN_TRIAL_EXTENSION_MAX_DAYS;
  protected readonly dateTime = dateTime;
  protected readonly day = formatLongDay;
  protected readonly selectClass =
    'min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

  protected readonly list = createAdminReport<AdminUserPage>();
  protected readonly detail = createAdminReport<AdminUserDetail>();
  protected readonly filters = signal<AdminUserListParams>({});
  protected readonly searchText = signal('');
  protected readonly searchError = signal('');
  protected readonly loadingMore = signal(false);

  protected readonly pendingAction = signal<AdminUserActionType | null>(null);
  protected readonly reason = signal('');
  protected readonly days = signal(7);
  protected readonly confirmEmail = signal('');
  protected readonly totpCode = signal('');
  protected readonly submitting = signal(false);
  protected readonly actionError = signal('');

  /** Fiche ouverte : paramètre `?fiche=<id>` (lien partageable, bouton retour du navigateur). */
  private readonly queryParams = toSignal(this.route.queryParamMap, { initialValue: null });
  protected readonly selectedId = computed(() => {
    const id = this.queryParams()?.get('fiche') ?? null;
    return id && UUID.test(id) ? id : null;
  });

  protected readonly activeFilters = computed(() => {
    const { plan, trialStatus, status, source, signupFrom, signupTo } = this.filters();
    return [plan, trialStatus, status, source, signupFrom, signupTo].filter((value) => value !== undefined && value !== '').length;
  });

  protected readonly byId = (row: AdminUserSummary) => row.id;
  protected readonly link = (row: AdminUserSummary): RjRowLink => ({ path: '/admin/utilisateurs', queryParams: { fiche: row.id } });

  protected readonly columns: readonly RjTableColumn<AdminUserSummary>[] = [
    { key: 'email', label: 'E-mail', value: (row) => row.email, primary: true },
    { key: 'plan', label: 'Plan', value: (row) => (row.planSource === 'free' ? PLAN_LABELS[row.plan] : `${PLAN_LABELS[row.plan]} · ${SOURCE_LABELS[row.planSource]}`) },
    { key: 'status', label: 'Statut', value: (row) => (row.role === 'ADMIN' ? 'Admin' : ADMIN_USER_STATUS_LABELS[row.status]) },
    { key: 'trial', label: 'Essai', value: (row) => TRIAL_LABELS[row.trialStatus], hideOnMobile: true },
    { key: 'source', label: 'Source', value: (row) => row.utmSource ?? '(direct)', hideOnMobile: true },
    { key: 'created', label: 'Inscription', value: (row) => dateTime(row.createdAt), mono: true },
  ];

  protected readonly canConfirm = computed(() => {
    const action = this.pendingAction();
    if (!action || this.submitting()) return false;
    if (action !== 'resend_verification' && this.reason().trim().length < 3) return false;
    if (action === 'extend_trial' && !(this.days() >= 1 && this.days() <= ADMIN_TRIAL_EXTENSION_MAX_DAYS)) return false;
    if (this.destructive(action) && this.confirmEmail().trim().toLowerCase() !== (this.detail.data()?.email ?? '').toLowerCase()) return false;
    if (action === 'delete' && !/^\d{6}$/.test(this.totpCode())) return false;
    return true;
  });

  constructor() {
    effect(() => {
      const query = this.filters();
      untracked(() => void this.list.load(() => this.api.users(query)));
    });
    effect(() => {
      const id = this.selectedId();
      untracked(() => {
        if (id) void this.detail.load(() => this.api.user(id));
        else this.detail.reset();
      });
    });
    this.destroyRef.onDestroy(() => this.detail.reset());
  }

  protected search(event: Event): void {
    event.preventDefault();
    const text = this.searchText().trim();
    if (text && text.length < ADMIN_USER_SEARCH_MIN_LENGTH) {
      this.searchError.set(`Saisis au moins ${ADMIN_USER_SEARCH_MIN_LENGTH} caractères.`);
      return;
    }
    this.searchError.set('');
    this.filters.update((current) => ({ ...current, q: text || undefined, cursor: undefined }));
  }

  protected setFilter(key: 'plan' | 'trialStatus' | 'status' | 'source' | 'signupFrom' | 'signupTo', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value.trim();
    this.filters.update((current) => ({ ...current, [key]: value === '' ? undefined : value, cursor: undefined }));
  }

  protected reload(): void {
    const query = this.filters();
    void this.list.load(() => this.api.users(query));
  }

  protected async more(page: AdminUserPage): Promise<void> {
    if (!page.nextCursor) return;
    this.loadingMore.set(true);
    try {
      const next = await this.api.users({ ...this.filters(), cursor: page.nextCursor });
      this.list.set({ ...next, items: [...page.items, ...next.items] });
    } catch {
      this.toasts.show('La suite de la liste n’a pas pu être chargée.', { tone: 'error' });
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected closeDetail(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { fiche: null }, queryParamsHandling: 'merge' });
  }

  protected destructive(action: AdminUserActionType): boolean {
    return ADMIN_DESTRUCTIVE_ACTIONS.includes(action);
  }

  protected startAction(action: AdminUserActionType): void {
    this.reason.set('');
    this.days.set(7);
    this.confirmEmail.set('');
    this.totpCode.set('');
    this.actionError.set('');
    this.pendingAction.set(action);
  }

  protected cancelAction(): void {
    this.pendingAction.set(null);
    this.totpCode.set('');
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    const action = this.pendingAction();
    const user = this.detail.data();
    if (!action || !user || !this.canConfirm()) return;
    const reason = this.reason().trim();
    const request: AdminUserActionRequest =
      action === 'extend_trial'
        ? { type: action, days: this.days(), reason }
        : action === 'suspend'
          ? { type: action, reason, confirmEmail: this.confirmEmail().trim().toLowerCase() }
          : action === 'delete'
            ? { type: action, reason, confirmEmail: this.confirmEmail().trim().toLowerCase(), totpCode: this.totpCode() }
            : action === 'resend_verification'
              ? { type: action }
              : { type: action, reason };
    this.submitting.set(true);
    this.actionError.set('');
    try {
      const result = await this.api.userAction(user.id, request);
      this.pendingAction.set(null);
      this.toasts.show(`${ADMIN_USER_ACTION_LABELS[action]} : fait et journalisé.`, { tone: 'success' });
      if (result.user) this.detail.set(result.user);
      else this.closeDetail();
      this.reload();
    } catch (error) {
      this.actionError.set(toClientError(error).message);
    } finally {
      this.submitting.set(false);
      this.totpCode.set('');
    }
  }

  protected count(value: number): string {
    return formatMetric(value, 'count');
  }

  protected trialText(user: AdminUserDetail): string {
    const label = TRIAL_LABELS[user.trial.status];
    if (user.trial.status === 'active' && user.trial.endsAt) return `${label}, fin le ${formatLongDay(user.trial.endsAt)}`;
    return label;
  }

  protected subscriptionText(user: AdminUserDetail): string {
    const sub = user.subscription;
    if (!sub) return 'Aucun';
    const interval = sub.interval === 'year' ? 'annuel' : 'mensuel';
    return `${interval}, ${SUBSCRIPTION_STATUS_TEXT[sub.status] ?? sub.status}${sub.cancelAtPeriodEnd ? ', résiliation demandée' : ''}`;
  }

  protected usage(user: AdminUserDetail): { label: string; value: string }[] {
    return [
      { label: 'Analyses aujourd’hui', value: this.count(user.usage.analysesToday) },
      { label: 'Analyses', value: this.count(user.usage.analyses30d) },
      { label: 'Scans de wallet', value: this.count(user.usage.walletScans30d) },
      { label: 'Alertes', value: this.count(user.usage.alerts30d) },
      { label: 'Suivis actifs', value: this.count(user.watches.active) },
      { label: 'Appareils push', value: this.count(user.pushSubscriptions) },
    ];
  }

  protected attribution(user: AdminUserDetail): { label: string; value: string }[] {
    const a = user.attribution;
    return [
      { label: 'Source', value: a.utmSource ?? NO_VALUE },
      { label: 'Support', value: a.utmMedium ?? NO_VALUE },
      { label: 'Campagne', value: a.utmCampaign ?? NO_VALUE },
      { label: 'Page d’arrivée', value: a.landingPath ?? NO_VALUE },
      { label: 'Référent', value: a.referrer ?? NO_VALUE },
    ];
  }

  protected auditLabel(entry: AuditLogEntry): string {
    return (ADMIN_AUDIT_ACTION_LABELS as Readonly<Record<string, string>>)[entry.action] ?? entry.action;
  }

  protected actorText(entry: AuditLogEntry): string {
    if (entry.actor) return entry.actor.email;
    return entry.actorKind === 'cli' ? 'CLI' : entry.actorKind === 'system' ? 'Système' : 'Compte supprimé';
  }
}

