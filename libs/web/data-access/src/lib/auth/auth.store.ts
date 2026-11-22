import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import {
  type AuthSession,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type MagicLinkRequest,
  type MessageResponse,
  type PublicUser,
  type RegisterRequest,
  type ResetPasswordRequest,
} from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth-api';
import { CsrfToken } from './csrf-token';

/**
 * - `idle` : session pas encore demandée ;
 * - `loading` : récupération initiale en cours ;
 * - `authenticated` / `anonymous` : état connu ;
 * - `error` : l'API n'a pas répondu (réseau, 5xx) : l'écran propose de réessayer.
 */
export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous' | 'error';

/**
 * Store d'auth en signals. Aucune donnée d'auth n'est écrite dans le stockage du navigateur :
 * les jetons sont en cookies httpOnly (gérés par l'API), le jeton CSRF en mémoire (`CsrfToken`).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(AuthApi);
  private readonly csrf = inject(CsrfToken);

  private readonly currentUser = signal<PublicUser | null>(null);
  private readonly currentStatus = signal<AuthStatus>('idle');
  private ready: Promise<void> | null = null;

  readonly user = this.currentUser.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly isAuthenticated = computed(() => this.currentStatus() === 'authenticated');
  readonly isLoading = computed(() => {
    const status = this.currentStatus();
    return status === 'idle' || status === 'loading';
  });
  readonly emailVerified = computed(() => this.currentUser()?.emailVerified ?? false);

  /**
   * Récupération initiale de la session (au démarrage, sans bloquer l'affichage).
   * Idempotent : les appels suivants renvoient la même promesse, sauf `force` (bouton Réessayer).
   */
  init(force = false): Promise<void> {
    if (!this.ready || force) {
      this.currentStatus.set('loading');
      this.ready = firstValueFrom(this.api.getSession()).then(
        (state) => {
          // 200 dans les deux cas : `{ authenticated: false }` pour un visiteur sans cookie de session.
          if (state.authenticated) {
            this.applySession(state);
          } else {
            this.clear();
          }
        },
        (error: unknown) => {
          const status = error instanceof HttpErrorResponse ? error.status : -1;
          // 401/403 : pas de session valide (le refresh a déjà été tenté par l'intercepteur).
          if (status === 401 || status === 403) {
            this.clear();
          } else {
            this.currentUser.set(null);
            this.currentStatus.set('error');
          }
        },
      );
    }
    return this.ready;
  }

  /** Attend que l'état de session soit connu (gardes de route). Lance `init` si besoin. */
  whenReady(): Promise<void> {
    return this.ready ?? this.init();
  }

  /** Applique une réponse de session (login, lien magique, vérification, refresh). */
  applySession(session: AuthSession): void {
    this.csrf.set(session.csrfToken);
    this.currentUser.set(session.user);
    this.currentStatus.set('authenticated');
  }

  /** Oublie la session locale (déconnexion, session expirée). Le jeton CSRF anonyme sera redemandé. */
  clear(): void {
    this.csrf.clear();
    this.currentUser.set(null);
    this.currentStatus.set('anonymous');
  }

  async login(body: LoginRequest): Promise<PublicUser> {
    const session = await firstValueFrom(this.api.login(body));
    this.applySession(session);
    return session.user;
  }

  register(body: RegisterRequest): Promise<MessageResponse> {
    return firstValueFrom(this.api.register(body));
  }

  async verifyEmail(token: string): Promise<PublicUser> {
    const session = await firstValueFrom(this.api.verifyEmail({ token }));
    this.applySession(session);
    return session.user;
  }

  /** Connecté : e-mail de la session ; sinon l'e-mail saisi. */
  resendVerification(email?: string): Promise<MessageResponse> {
    return firstValueFrom(this.api.resendVerification(this.isAuthenticated() || !email ? {} : { email }));
  }

  requestMagicLink(body: MagicLinkRequest): Promise<MessageResponse> {
    return firstValueFrom(this.api.requestMagicLink(body));
  }

  /** Renvoie aussi le `redirectPath` mémorisé par l'API (non fiable : passer par `safeRedirect`). */
  async verifyMagicLink(token: string): Promise<{ user: PublicUser; redirectPath: string | null }> {
    const session = await firstValueFrom(this.api.verifyMagicLink({ token }));
    this.applySession(session);
    return { user: session.user, redirectPath: session.redirectPath };
  }

  forgotPassword(body: ForgotPasswordRequest): Promise<MessageResponse> {
    return firstValueFrom(this.api.forgotPassword(body));
  }

  /** Toutes les sessions sont révoquées par l'API : l'utilisateur se reconnecte. */
  async resetPassword(body: ResetPasswordRequest): Promise<void> {
    await firstValueFrom(this.api.resetPassword(body));
    this.clear();
  }

  changePassword(body: ChangePasswordRequest): Promise<void> {
    return firstValueFrom(this.api.changePassword(body));
  }

  /** Relit le profil (après vérification d'e-mail dans un autre onglet, par exemple). */
  async reloadUser(): Promise<void> {
    const user = await firstValueFrom(this.api.me());
    this.currentUser.set(user);
  }

  /** Déconnexion : la session locale est oubliée même si l'API ne répond pas. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      // Cookies expirés ou API injoignable : on oublie quand même la session côté front.
    }
    this.clear();
  }

  exportData(): Promise<Blob> {
    return firstValueFrom(this.api.exportData());
  }

  async deleteAccount(body: DeleteAccountRequest): Promise<void> {
    await firstValueFrom(this.api.deleteAccount(body));
    this.clear();
  }
}
