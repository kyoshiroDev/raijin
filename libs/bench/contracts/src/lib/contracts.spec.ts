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
  SHADOW_ACCEPTANCE,
  SHADOW_TABLES,
  evaluateShadowAcceptance,
  fullUtcDays,
  shadowComparisonQuerySchema,
  shadowComparisonSchema,
  tokenListQuerySchema,
  type ShadowComparison,
  type ShadowDayRow,
  type ShadowTable,
} from '../index';

const MINT = 'So11111111111111111111111111111111111111112';

describe('contrats du banc', () => {
  it('connexion : mot de passe et TOTP ensemble, champs inconnus refusés', () => {
    const ok = benchLoginRequestSchema.parse({ email: ' Owner@Example.com ', password: 'x', totp: '123 456' });
    expect(ok).toEqual({ email: 'owner@example.com', password: 'x', totp: '123456' });
    expect(benchLoginRequestSchema.safeParse({ email: 'owner@example.com', password: 'x' }).success).toBe(false);
    expect(benchLoginRequestSchema.safeParse({ email: 'owner@example.com', password: 'x', totp: '123456', remember: true }).success).toBe(false);
    expect(benchLoginRequestSchema.parse({ email: 'owner@example.com', password: 'x', recovery_code: ' abcde-fgh23 ' }).recovery_code).toBe('ABCDE-FGH23');
    expect(benchLoginRequestSchema.safeParse({ email: 'owner@example.com', password: 'x', totp: '123456', recovery_code: 'ABCDE-FGH23' }).success).toBe(false);
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

  describe('seuils de bascule du mode ombre (BENCH.md §12)', () => {
    const row = (table: ShadowTable, day: string, vps: number, ref: number, only: [number, number] | null = [0, 0]): ShadowDayRow => ({
      table,
      day,
      vps_rows: vps,
      ref_rows: ref,
      diff_pct: ref === 0 ? null : ((vps - ref) / ref) * 100,
      only_vps_count: table === 'scan_runs' || only === null ? null : only[0],
      only_ref_count: table === 'scan_runs' || only === null ? null : only[1],
      only_vps_sample: [],
      only_ref_sample: [],
    });
    const DAYS = ['2026-12-02', '2026-12-03', '2026-12-04'];
    // Instantané --since 2026-12-02 --until 2026-12-05T09:30Z : 3 jours complets (le 05 est partiel).
    const base = (rows: ShadowDayRow[], over: Partial<ShadowComparison> = {}): ShadowComparison => ({
      snapshot_at: '2026-12-05T09:31:00.000Z',
      snapshot_window: { from: '2026-12-02T00:00:00.000Z', to: '2026-12-05T09:30:00.000Z' },
      from: '2026-12-02',
      to: '2026-12-05',
      rows,
      ...over,
    });
    const healthy = (): ShadowDayRow[] =>
      DAYS.flatMap((d) => [
        row('scan_runs', d, 286, 288),
        row('tokens', d, 400, 410, [12, 20]),
        row('token_snapshots', d, 9_800, 10_000),
        row('signal_outcomes', d, 260, 270, [8, 15]),
        row('preset_signals', d, 95, 100, [3, 5]),
        row('alert_log', d, 0, 12),
        row('paper_positions', d, 1, 30),
      ]);

    it('constantes cohérentes : toutes les tables, alert_log et paper_positions informatives, Helius 80 %', () => {
      expect(Object.keys(SHADOW_ACCEPTANCE.tables).sort()).toEqual([...SHADOW_TABLES].sort());
      expect(SHADOW_TABLES.filter((t) => !SHADOW_ACCEPTANCE.tables[t].blocking)).toEqual(['alert_log', 'paper_positions']);
      for (const t of SHADOW_TABLES) {
        const tol = SHADOW_ACCEPTANCE.tables[t];
        expect(tol.maxDayDiffPct).toBeGreaterThanOrEqual(tol.maxWindowDiffPct);
      }
      expect(SHADOW_ACCEPTANCE.minFullDays).toBeLessThanOrEqual(SHADOW_ACCEPTANCE.recommendedFullDays);
      expect(SHADOW_ACCEPTANCE.heliusMaxDailyRatio * 10_000).toBe(8_000);
      expect(SHADOW_ACCEPTANCE.jobs.maxFailedLast24h).toBe(0);
    });

    it('jours complets seulement : le jour de démarrage et celui de l’instantané sont exclus', () => {
      expect(fullUtcDays('2026-12-01T14:05:00Z', '2026-12-05T09:30:00Z')).toEqual(['2026-12-02', '2026-12-03', '2026-12-04']);
      expect(fullUtcDays('2026-12-02T00:00:00Z', '2026-12-03T00:00:00Z')).toEqual(['2026-12-02']);
      expect(fullUtcDays('2026-12-02T10:00:00Z', '2026-12-03T09:00:00Z')).toEqual([]);
    });

    it('fenêtre conforme : bascule possible, jour partiel ignoré, tables informatives sans effet', () => {
      const partialDay = row('scan_runs', '2026-12-05', 300, 114);
      const result = evaluateShadowAcceptance(base([...healthy(), partialDay]));
      expect(result.status).toBe('pass');
      expect(result.fullDays).toEqual(DAYS);
      const scan = result.tables.find((t) => t.table === 'scan_runs');
      expect(scan).toMatchObject({ status: 'pass', days: 3, vpsRows: 858, refRows: 864 });
      expect(result.tables.find((t) => t.table === 'alert_log')?.status).toBe('info');
      expect(result.tables.find((t) => t.table === 'tokens')?.oneSideMintPct).toBeCloseTo((60 / 1230) * 100, 5);
    });

    it('hors tolérance : écart de fenêtre, pire jour, mints d’un seul côté', () => {
      const rows = healthy().map((r) => {
        if (r.table === 'scan_runs' && r.day === '2026-12-03') return row('scan_runs', r.day, 260, 288); // −9,7 % un jour
        if (r.table === 'tokens') return row('tokens', r.day, 410, 410, [0, 50]); // 150 / 1230 = 12,2 %
        if (r.table === 'token_snapshots') return row('token_snapshots', r.day, 9_000, 10_000); // −10 % sur la fenêtre
        return r;
      });
      const result = evaluateShadowAcceptance(base(rows));
      expect(result.status).toBe('fail');
      const byTable = new Map(result.tables.map((t) => [t.table, t]));
      expect(byTable.get('scan_runs')?.status).toBe('fail');
      expect(byTable.get('scan_runs')?.reasons.join(' ')).toContain('sur un jour (max 5 %)');
      expect(byTable.get('tokens')?.reasons.join(' ')).toContain('mints d\'un seul côté (max 10 %)');
      expect(byTable.get('token_snapshots')?.reasons.join(' ')).toContain('sur la fenêtre (max 5 %)');
    });

    it('échantillon insuffisant (n < 30) bloque, puis devient non concluant après 14 jours', () => {
      const thin = healthy().map((r) => (r.table === 'preset_signals' ? row('preset_signals', r.day, 5, 6) : r));
      const short = evaluateShadowAcceptance(base(thin));
      expect(short.status).toBe('insufficient');
      expect(short.tables.find((t) => t.table === 'preset_signals')).toMatchObject({ status: 'insufficient', refRows: 18 });
      const days = fullUtcDays('2026-12-01T00:00:00Z', '2026-12-15T00:00:00Z');
      expect(days).toHaveLength(14);
      const long = evaluateShadowAcceptance(
        base(
          days.flatMap((d) => healthy().filter((r) => r.day === DAYS[0]).map((r) => (r.table === 'preset_signals' ? row('preset_signals', d, 1, 1) : { ...r, day: d }))),
          { snapshot_window: { from: '2026-12-01T00:00:00Z', to: '2026-12-15T00:00:00Z' }, from: '2026-12-01', to: '2026-12-15' },
        ),
      );
      expect(long.tables.find((t) => t.table === 'preset_signals')?.status).toBe('inconclusive');
      expect(long.status).toBe('pass');
    });

    it('sans instantané, trop court ou fenêtre tronquée : pas de verdict de bascule', () => {
      expect(evaluateShadowAcceptance(base([], { snapshot_at: null, snapshot_window: null })).status).toBe('no_snapshot');
      expect(evaluateShadowAcceptance(base(healthy(), { snapshot_window: { from: '2026-12-02T00:00:00Z', to: '2026-12-04T00:00:00Z' } })).status).toBe('too_short');
      expect(evaluateShadowAcceptance(base(healthy(), { from: '2026-12-03' })).status).toBe('partial');
      // Une table bloquante absente de la réponse compte 0 ligne : échantillon insuffisant.
      expect(evaluateShadowAcceptance(base(healthy().filter((r) => r.table !== 'signal_outcomes'))).status).toBe('insufficient');
    });

    it('réponse : fenêtre de l’instantané au contrat', () => {
      expect(shadowComparisonSchema.safeParse(base(healthy())).success).toBe(true);
      expect(shadowComparisonSchema.safeParse({ ...base(healthy()), snapshot_window: undefined }).success).toBe(false);
    });
  });
});
