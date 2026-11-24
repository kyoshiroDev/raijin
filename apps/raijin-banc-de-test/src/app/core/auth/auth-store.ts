import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BENCH_MODES, BENCH_ROUTES, type BenchLoginRequest, type BenchMode, type BenchSession } from '@raijin/bench-contracts';
import { BenchApi, isBenchApiError } from '../api/bench-api';

/** Résultat d'une connexion : jamais le texte brut du serveur (un seul message pour identifiants et code). */
export type SignInResult = 'ok' | 'invalid' | 'throttled' | 'error';

const MODES: readonly string[] = BENCH_MODES;

/** Réponse `BenchSession` non fiable → session, ou null. */
export function parseBenchSession(body: unknown): BenchSession | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  const email = r['email'];
  const mode = r['mode'];
  const expiresAt = r['expiresAt'];
  if (typeof email !== 'string' || email.length === 0 || email.length > 254) return null;
  if (typeof mode !== 'string' || !MODES.includes(mode)) return null;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { email, mode: mode as BenchMode, expiresAt };
}

/**
 * Session du propriétaire du banc (compte unique, mot de passe + TOTP, docs/ARCHITECTURE.md §17.7). La session vit
 * dans un cookie httpOnly posé par l'API : le front ne garde que la description renvoyée (`BenchSession`). Créé au
 * démarrage (app.config.ts) pour lire la session avant la première garde de route. Tout 401 d'une route protégée
 * oublie la session et renvoie à /login.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(BenchApi);
  private readonly router = inject(Router);

  private readonly _session = signal<BenchSession | null>(null);
  private readonly _ready = signal(false);

  readonly session = this._session.asReadonly();
  readonly ready = this._ready.asReadonly();
  readonly isAuthenticated = computed(() => this._session() !== null);
  readonly email = computed(() => this._session()?.email ?? null);
  /** `shadow` : banc en mode ombre (aucune notification) ; `primary` : référence après bascule. */
  readonly mode = computed(() => this._session()?.mode ?? null);

  private readonly initialized: Promise<void>;

  constructor() {
    this.api.onUnauthorized(() => this.expire());
    this.initialized = this.init();
  }

  private async init(): Promise<void> {
    try {
      this._session.set(parseBenchSession(await this.api.get(BENCH_ROUTES.authSession, { anonymous: true })));
    } catch {
      this._session.set(null);
    } finally {
      this._ready.set(true);
    }
  }

  whenReady(): Promise<void> {
    return this.initialized;
  }

  /** Connexion en une étape : e-mail, mot de passe et code TOTP (ou code de secours). */
  async signIn(request: BenchLoginRequest): Promise<SignInResult> {
    try {
      const session = parseBenchSession(await this.api.post(BENCH_ROUTES.authLogin, request, { anonymous: true }));
      if (session === null) return 'error';
      this._session.set(session);
      return 'ok';
    } catch (error) {
      if (isBenchApiError(error, 429)) return 'throttled';
      if (isBenchApiError(error, 401) || isBenchApiError(error, 400)) return 'invalid';
      return 'error';
    }
  }

  /** Déconnexion : la session est révoquée côté API (best effort) et oubliée ici dans tous les cas. */
  async signOut(): Promise<void> {
    try {
      await this.api.post(BENCH_ROUTES.authLogout, undefined, { anonymous: true });
    } catch {
      // Session déjà expirée ou API injoignable : rien d'autre à faire côté navigateur.
    }
    this._session.set(null);
  }

  /** 401 d'une route protégée : session expirée, révoquée, ou cookie d'une autre application. */
  private expire(): void {
    this._session.set(null);
    if (!this.router.url.startsWith('/login')) void this.router.navigateByUrl('/login', { replaceUrl: true });
  }
}
