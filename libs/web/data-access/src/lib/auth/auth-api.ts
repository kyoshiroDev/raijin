import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  type AuthSession,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type MagicLinkRequest,
  type MagicLinkSession,
  type MagicLinkVerifyRequest,
  type MessageResponse,
  type PublicUser,
  type RegisterRequest,
  type ResendVerificationRequest,
  type ResetPasswordRequest,
  type SessionState,
  type VerifyEmailRequest,
} from '@raijin/shared-contracts';
import { Observable, from, map, of, switchMap, type OperatorFunction } from 'rxjs';
import { loadContracts, type Contracts } from '../contracts';
import { API_BASE_URL } from '../config/api-config';
import { SKIP_SESSION_REFRESH } from '../http/context';

/** Valide la réponse avec un schéma des contrats (chargés à la demande, hors bundle initial). */
function parseWith<T>(pick: (contracts: Contracts) => { parse(value: unknown): T }): OperatorFunction<unknown, T> {
  return switchMap((body) => from(loadContracts()).pipe(map((contracts) => pick(contracts).parse(body))));
}

/** `{ authenticated: false }` (clés en plus ignorées, comme le schéma Zod non strict). */
export function isAnonymousState(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { authenticated?: unknown }).authenticated === false;
}

/** Appels d'auth qui ne doivent jamais déclencher de refresh sur 401 (ils créent ou détruisent la session). */
const NO_REFRESH = () => new HttpContext().set(SKIP_SESSION_REFRESH, true);

/**
 * Client HTTP des routes `/api/v1/auth/*` et `/api/v1/users/me` (contrats `@raijin/shared-contracts`).
 * Chaque réponse est validée par son schéma Zod : une réponse inattendue devient une erreur.
 */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  private url(path: string): string {
    return `${this.base}/${path}`;
  }

  private session(path: string, body: unknown, context = NO_REFRESH()): Observable<AuthSession> {
    return this.http.post(this.url(path), body, { context }).pipe(parseWith((c) => c.authSessionSchema));
  }

  private message(path: string, body: unknown): Observable<MessageResponse> {
    return this.http
      .post(this.url(path), body, { context: NO_REFRESH() })
      .pipe(parseWith((c) => c.messageResponseSchema));
  }

  /**
   * GET /auth/session : état de session (`SessionState`). Sans cookie de session, l'API répond 200
   * `{ authenticated: false }` (aucune erreur réseau pour un visiteur anonyme) ; un cookie expiré
   * ou invalide donne 401 `AUTH_SESSION_EXPIRED` et passe par le refresh automatique.
   */
  getSession(): Observable<SessionState> {
    return this.http.get(this.url('auth/session')).pipe(
      // Visiteur anonyme : réponse validée sans charger Zod (même résultat que
      // `anonymousSessionStateSchema`, objet non strict). Une session passe par le schéma complet.
      switchMap((body) => (isAnonymousState(body) ? of<SessionState>({ authenticated: false }) : of(body).pipe(parseWith((c) => c.sessionStateSchema)))),
    );
  }

  /** GET /users/me : profil à jour. */
  me(): Observable<PublicUser> {
    return this.http.get(this.url('users/me')).pipe(parseWith((c) => c.publicUserSchema));
  }

  login(body: LoginRequest): Observable<AuthSession> {
    return this.session('auth/login', body);
  }

  register(body: RegisterRequest): Observable<MessageResponse> {
    return this.message('auth/register', body);
  }

  refresh(): Observable<AuthSession> {
    return this.session('auth/refresh', {});
  }

  logout(): Observable<void> {
    return this.http
      .post(this.url('auth/logout'), {}, { context: NO_REFRESH() })
      .pipe(map(() => undefined));
  }

  verifyEmail(body: VerifyEmailRequest): Observable<AuthSession> {
    return this.session('auth/verify-email', body);
  }

  /** Connecté : corps vide (e-mail de la session). Déconnecté : e-mail fourni. Réponse neutre. */
  resendVerification(body: ResendVerificationRequest): Observable<MessageResponse> {
    return this.message('auth/verify-email/resend', body);
  }

  requestMagicLink(body: MagicLinkRequest): Observable<MessageResponse> {
    return this.message('auth/magic-link', body);
  }

  /** Session + `redirectPath` mémorisé par l'API lors de la demande (à revalider côté front). */
  verifyMagicLink(body: MagicLinkVerifyRequest): Observable<MagicLinkSession> {
    return this.http
      .post(this.url('auth/magic-link/verify'), body, { context: NO_REFRESH() })
      .pipe(parseWith((c) => c.magicLinkSessionSchema));
  }

  forgotPassword(body: ForgotPasswordRequest): Observable<MessageResponse> {
    return this.message('auth/password/forgot', body);
  }

  resetPassword(body: ResetPasswordRequest): Observable<void> {
    return this.http
      .post(this.url('auth/password/reset'), body, { context: NO_REFRESH() })
      .pipe(map(() => undefined));
  }

  /** Connecté : passe par le refresh automatique (un 401 `AUTH_INVALID_CREDENTIALS` n'en déclenche pas). */
  changePassword(body: ChangePasswordRequest): Observable<void> {
    return this.http.post(this.url('auth/password/change'), body).pipe(map(() => undefined));
  }

  /** GET /users/me/export : export RGPD de toutes les données du compte (JSON en pièce jointe). */
  exportData(): Observable<Blob> {
    return this.http.get(this.url('users/me/export'), { responseType: 'blob' });
  }

  /** DELETE /users/me (corps `DeleteAccountRequest { password }`) → 204, sessions révoquées. */
  deleteAccount(body: DeleteAccountRequest): Observable<void> {
    return this.http.delete(this.url('users/me'), { body }).pipe(map(() => undefined));
  }
}
