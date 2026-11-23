import {
  BENCH_ROUTES,
  benchCookieNames,
  benchErrorSchema,
  benchEventSchema,
  benchLoginRequestSchema,
  jobRunSchema,
  mintListQuerySchema,
  paperOpenRequestSchema,
  paperPositionsQuerySchema,
  shadowComparisonQuerySchema,
  tokenListQuerySchema,
} from '../index';

const MINT = 'So11111111111111111111111111111111111111112';

describe('contrats du banc', () => {
  it('connexion : mot de passe et TOTP ensemble, champs inconnus refusés', () => {
    const ok = benchLoginRequestSchema.parse({ email: ' Owner@Example.com ', password: 'x', totp: '123 456' });
    expect(ok).toEqual({ email: 'owner@example.com', password: 'x', totp: '123456' });
    expect(benchLoginRequestSchema.safeParse({ email: 'owner@example.com', password: 'x' }).success).toBe(false);
    expect(benchLoginRequestSchema.safeParse({ email: 'owner@example.com', password: 'x', totp: '123456', remember: true }).success).toBe(false);
  });

  it('cookies distincts de Raijin (rj_*)', () => {
    for (const secure of [true, false]) {
      const names = benchCookieNames(secure);
      expect(names.session).toMatch(/rjb_session$/);
      expect(names.csrf).toMatch(/rjb_csrf$/);
    }
  });

  it('erreurs : code connu uniquement', () => {
    expect(benchErrorSchema.safeParse({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Refusé.' }).success).toBe(true);
    expect(benchErrorSchema.safeParse({ code: 'AUTH_EMAIL_NOT_VERIFIED', message: 'x' }).success).toBe(false);
  });

  it('paper : valeurs par défaut et bornes', () => {
    const req = paperOpenRequestSchema.parse({ mint: MINT, strategy: 'all_x2', stake_sol: 0.1, entry_price: 0.0001 });
    expect(req).toMatchObject({ sl_pct: 30, book: 'main', custom_tp_price: null, custom_sl_price: null });
    expect(paperOpenRequestSchema.safeParse({ mint: MINT, strategy: 'all_x2', stake_sol: 1000, entry_price: 1 }).success).toBe(false);
    expect(paperPositionsQuerySchema.parse({ books: 'main,calm_sl30' }).books).toEqual(['main', 'calm_sl30']);
    expect(paperPositionsQuerySchema.safeParse({ books: 'main,inconnu' }).success).toBe(false);
  });

  it('requêtes : limites converties depuis le texte et plafonnées', () => {
    expect(tokenListQuerySchema.parse({ since: '2026-11-23T00:00:00Z', limit: '50' }).limit).toBe(50);
    expect(tokenListQuerySchema.safeParse({ since: '2026-11-23T00:00:00Z', limit: '5000' }).success).toBe(false);
    expect(mintListQuerySchema.parse({ mints: `${MINT},` }).mints).toEqual([MINT]);
    expect(mintListQuerySchema.safeParse({ mints: 'pas-un-mint' }).success).toBe(false);
  });

  it('comparaison ombre : fenêtre ordonnée de 31 jours au plus', () => {
    expect(shadowComparisonQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-02' }).success).toBe(true);
    expect(shadowComparisonQuerySchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(false);
    expect(shadowComparisonQuerySchema.safeParse({ from: '2026-01-01', to: '2026-11-01' }).success).toBe(false);
  });

  it('SSE : union discriminée sur `type`', () => {
    const run = { id: '1', job: 'scan-tokens', status: 'skipped', started_at: '2026-11-23T10:00:00Z', finished_at: null, duration_ms: null, error: null };
    expect(jobRunSchema.safeParse(run).success).toBe(true);
    expect(benchEventSchema.parse({ type: 'job.finished', run }).type).toBe('job.finished');
    expect(benchEventSchema.safeParse({ type: 'paper.changed', book: 'main', position_id: null }).success).toBe(true);
    expect(benchEventSchema.safeParse({ type: 'inconnu' }).success).toBe(false);
  });

  it('routes : aucune inscription ni réinitialisation', () => {
    const paths = Object.values(BENCH_ROUTES).join(' ');
    expect(paths).not.toMatch(/register|signup|forgot|reset-password|magic/);
  });
});
