import {
  watchEventSchema,
  watchSnapshotSchema,
  type HoldersSnapshot,
  type VerdictSnapshot,
  type WatchSnapshot,
} from '@raijin/shared-contracts';
import {
  WATCH_EVENT_THRESHOLDS,
  WATCH_RULES_VERSION,
  detectWatchEvents,
  lpReference,
  mergeWatchSnapshot,
  type PoolReading,
  type WatchObservation,
} from './watch';

const MINT = '96UtJumDxTCNHvJqKRLemHPKgzbt5zfyMBNwaxyz8AdD';
const POOL = 'FSoQhd7utfk7UCSMJvk87ihr721sWWjdsnidtpgn9t7G';
const POOL2 = '6ZiTyq5vCy7uwxV8ipR4ivszaxVrEFyjPLnFxdNnXC1i';
const H1 = '92NCNbpnnVZgkb5ycMUaDfrrMQe8tUf8t84oFqDU4VwM';
const H2 = 'GNU8PsEysQEjiQ6wJGE6dCAt9YKtUFPQDY8Zy4MiRBva';
const H3 = '2X8Lm8sZng5kre348taq69MExdLY31rJvwa1CBK1eEaf';
const TA1 = 'CL8196HMr36xeYdb3diZxSqCSDN6vDrpWm2PtSSDqfJp';
const TA2 = 'CftHYqaF44Za6xYBZmYJRdXqKvU4LrozuRaA2oBSovJx';
const TA3 = '8voHJFjNnbT6wmBxpBWp547vReiQXQWp84HEpLr2tCCJ';
const TA4 = '8mEAPUd2FQFajeegozFop1iW2TkeNqDcEn3cE2ahbc5m';
const ANALYSIS_1 = '0b6f5a8e-2a54-4c3e-9f3e-1d2c3b4a5f60';
const ANALYSIS_2 = '1c7a6b9f-3b65-4d4f-8a4f-2e3d4c5b6a71';

const T0 = Date.parse('2026-11-22T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function reading(minutes: number, base: number, quote: number, overrides: Partial<PoolReading> = {}): PoolReading {
  return {
    address: POOL,
    dex: 'raydium',
    base,
    quote,
    sqrtK: Math.sqrt(base * quote),
    liquidityUsd: quote * 2 * 150,
    observedAt: at(minutes),
    ...overrides,
  };
}

function authorities(minutes: number, mint: boolean, freeze: boolean) {
  return { mintAuthorityActive: mint, freezeAuthorityActive: freeze, observedAt: at(minutes) };
}

function verdict(minutes: number, value: VerdictSnapshot['verdict'], extra: Partial<VerdictSnapshot> = {}): VerdictSnapshot {
  return { verdict: value, engineVersion: '1.0.0', analysisId: ANALYSIS_1, reasonCodes: [], observedAt: at(minutes), ...extra };
}

/** Offre 1 000 000 000 ; montants en unités brutes. */
function holders(minutes: number, top: Array<[string, string, number]>, supply = 1_000_000_000): HoldersSnapshot {
  return {
    supply: String(supply),
    top: top.map(([owner, tokenAccount, amount]) => ({ owner, tokenAccount, amount: String(amount), pct: supply > 0 ? (amount / supply) * 100 : 0 })),
    observedAt: at(minutes),
  };
}

function snapshot(groups: Partial<Omit<WatchSnapshot, 'version' | 'mint'>> = {}): WatchSnapshot {
  return watchSnapshotSchema.parse({ version: 1, mint: MINT, authorities: null, pool: null, holders: null, verdict: null, ...groups });
}

/** Rejoue une suite d'observations et renvoie les événements de chaque étape (validés par le contrat). */
function replay(observations: Array<Omit<WatchObservation, 'mint'>>) {
  let current: WatchSnapshot | null = null;
  return observations.map((observation) => {
    const next = mergeWatchSnapshot(current, { mint: MINT, ...observation });
    expect(watchSnapshotSchema.parse(next)).toEqual(next);
    const events = detectWatchEvents(current, next);
    for (const event of events) expect(watchEventSchema.parse(event)).toEqual(event);
    current = next;
    return { snapshot: next, events };
  });
}

describe('constantes', () => {
  it('seuils par défaut documentés (docs/SCORING.md, Événements de suivi)', () => {
    expect(WATCH_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WATCH_EVENT_THRESHOLDS).toMatchObject({
      lpDropPct: 30,
      lpReferenceWindowHours: 6,
      holderMinPct: 5,
      holderSellMinPositionPct: 25,
      holderSellMinSupplyPts: 1,
    });
  });
});

describe('première observation et données indisponibles', () => {
  it('première observation : référence, aucun événement', () => {
    const [first] = replay([{ authorities: authorities(0, true, true), pool: { main: reading(0, 1e6, 1e3) }, verdict: verdict(0, 'danger') }]);
    expect(first?.events).toEqual([]);
    expect(first?.snapshot.pool).toMatchObject({ peakSqrtK: Math.sqrt(1e9), peakAt: at(0) });
    expect(detectWatchEvents(null, first!.snapshot)).toEqual([]);
  });

  it.each<[string, Omit<WatchObservation, 'mint'>]>([
    ['groupes indisponibles (null)', { authorities: null, pool: null, holders: null, verdict: null }],
    ['groupes non collectés (absents)', {}],
  ])('%s : groupes précédents conservés, aucun événement', (_name, observation) => {
    const steps = replay([
      { authorities: authorities(0, false, false), pool: { main: reading(0, 1e6, 1e3) }, holders: holders(0, [[H1, TA1, 100_000_000]]), verdict: verdict(0, 'safe') },
      observation,
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot).toEqual(steps[0]?.snapshot);
  });

  it('observation plus ancienne que le groupe stocké (passe rejouée) : ignorée', () => {
    const steps = replay([
      { authorities: authorities(10, false, false), verdict: verdict(10, 'safe'), holders: holders(10, [[H1, TA1, 100_000_000]]) },
      { authorities: authorities(5, true, true), verdict: verdict(5, 'danger'), holders: holders(5, [[H1, TA1, 1]]) },
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot.authorities?.observedAt).toBe(at(10));
  });

  it('autre mint ou instantané précédent absent : aucun événement', () => {
    const next = snapshot({ authorities: authorities(5, true, false) });
    const other = { ...snapshot({ authorities: authorities(0, false, false) }), mint: POOL2 };
    expect(detectWatchEvents(other, next)).toEqual([]);
    // Fusion avec l'instantané d'un autre mint : repart de zéro.
    expect(mergeWatchSnapshot(other, { mint: MINT }).authorities).toBeNull();
  });

  it('rejouer la même détection : mêmes clés (idempotence)', () => {
    const previous = snapshot({ authorities: authorities(0, false, false) });
    const next = mergeWatchSnapshot(previous, { mint: MINT, authorities: authorities(5, true, false) });
    expect(detectWatchEvents(previous, next)).toEqual(detectWatchEvents(previous, next));
    expect(detectWatchEvents(previous, next)[0]?.dedupeKey).toBe(`mint_reactivated:${at(5)}`);
  });
});

describe('verdict dégradé', () => {
  it.each<[string, VerdictSnapshot['verdict'], VerdictSnapshot['verdict'], 'warn' | 'danger' | null]>([
    ['Sain → Prudence', 'safe', 'warn', 'warn'],
    ['Sain → Danger', 'safe', 'danger', 'danger'],
    ['Prudence → Danger', 'warn', 'danger', 'danger'],
    ['Prudence → Prudence', 'warn', 'warn', null],
    ['Danger → Prudence (amélioration)', 'danger', 'warn', null],
    ['Prudence → Sain (amélioration)', 'warn', 'safe', null],
  ])('%s', (_name, from, to, severity) => {
    const reasons = ['MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_ACTIVE', 'LIQUIDITY_LOW', 'TOP10_CONCENTRATION_HIGH', 'TOKEN_VERY_NEW', 'POOL_VERY_NEW', 'METADATA_MUTABLE', 'SELL_PRICE_IMPACT_HIGH', 'SELL_TAX_HIGH'];
    const steps = replay([
      { verdict: verdict(0, from) },
      { verdict: verdict(360, to, { analysisId: ANALYSIS_2, reasonCodes: reasons as VerdictSnapshot['reasonCodes'] }) },
    ]);
    const events = steps[1]?.events ?? [];
    if (severity === null) {
      expect(events).toEqual([]);
      return;
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'verdict_degraded',
      severity,
      payload: { from, to, analysisId: ANALYSIS_2 },
      dedupeKey: `verdict_degraded:${from}>${to}:${ANALYSIS_2}`,
      detectedAt: at(360),
    });
    expect(events[0]?.type === 'verdict_degraded' && events[0].payload.reasonCodes).toHaveLength(8);
  });

  it('sans identifiant d’analyse : clé sur la date de la réanalyse', () => {
    const steps = replay([{ verdict: verdict(0, 'safe') }, { verdict: verdict(360, 'warn', { analysisId: null }) }]);
    expect(steps[1]?.events[0]?.dedupeKey).toBe(`verdict_degraded:safe>warn:${at(360)}`);
  });

  it('version majeure du moteur changée : nouvelle référence sans alerte ; mineure : comparée', () => {
    const major = replay([{ verdict: verdict(0, 'safe') }, { verdict: verdict(360, 'danger', { engineVersion: '2.0.0' }) }]);
    expect(major[1]?.events).toEqual([]);
    const minor = replay([{ verdict: verdict(0, 'safe') }, { verdict: verdict(360, 'danger', { engineVersion: '1.1.0-variante.a' }) }]);
    expect(minor[1]?.events).toHaveLength(1);
  });
});

describe('autorités mint et freeze', () => {
  it.each<[string, [boolean, boolean], [boolean, boolean], string[]]>([
    ['mint réactivé', [false, false], [true, false], ['mint_reactivated']],
    ['freeze réactivé', [false, false], [false, true], ['freeze_reactivated']],
    ['les deux', [false, false], [true, true], ['mint_reactivated', 'freeze_reactivated']],
    ['déjà actives : pas de nouvel événement', [true, true], [true, true], []],
    ['révoquées : rien', [true, true], [false, false], []],
  ])('%s', (_name, [mint0, freeze0], [mint1, freeze1], types) => {
    const steps = replay([{ authorities: authorities(0, mint0, freeze0) }, { authorities: authorities(5, mint1, freeze1) }]);
    const events = steps[1]?.events ?? [];
    expect(events.map((event) => event.type)).toEqual(types);
    for (const event of events) {
      expect(event).toMatchObject({ severity: 'danger', payload: { revokedObservedAt: at(0) }, detectedAt: at(5) });
      expect(event.dedupeKey).toBe(`${event.type}:${at(5)}`);
    }
  });
});

describe('liquidité retirée (√(base × quote) du pool suivi)', () => {
  it('swaps (k constant) : aucun événement ; retrait de 70 % : lp_removed, puis référence remise au niveau courant', () => {
    const steps = replay([
      { pool: { main: reading(0, 1_000_000, 1_000) } },
      // Swap : k inchangé (≈ 1e9), prix différent.
      { pool: { main: reading(5, 800_000, 1_250) } },
      // Retrait de liquidité : √k divisé par ~3,3.
      { pool: { main: reading(10, 300_000, 375) } },
      // Pass suivante au même niveau : pas de nouvel événement (référence remise à jour).
      { pool: { main: reading(15, 300_000, 375) } },
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[2]?.events).toHaveLength(1);
    expect(steps[2]?.events[0]).toMatchObject({
      type: 'lp_removed',
      severity: 'danger',
      payload: { poolAddress: POOL, dex: 'raydium', dropPct: 66.46, liquidityUsdBefore: 375_000, liquidityUsdAfter: 112_500, referenceAt: at(5) },
      dedupeKey: `lp_removed:${POOL}:${at(5)}`,
      detectedAt: at(10),
    });
    expect(steps[2]?.snapshot.pool).toMatchObject({ peakAt: at(10) });
    expect(steps[3]?.events).toEqual([]);
  });

  it('baisse de 25 % : sous le seuil ; le plus haut est conservé', () => {
    const steps = replay([{ pool: { main: reading(0, 1e6, 1e3) } }, { pool: { main: reading(5, 750_000, 750) } }]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot.pool).toMatchObject({ peakSqrtK: Math.sqrt(1e9), peakAt: at(0) });
  });

  it('baisses successives : comparées au plus haut des 6 dernières heures', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3) } },
      { pool: { main: reading(60, 800_000, 800) } }, // −20 %
      { pool: { main: reading(120, 650_000, 650) } }, // −35 % vs plus haut
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[2]?.events[0]).toMatchObject({ type: 'lp_removed', payload: { dropPct: 35, referenceAt: at(0) } });
  });

  it('plus haut de plus de 6 h : la dernière mesure sert de référence', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3) } },
      { pool: { main: reading(60, 800_000, 800) } },
      { pool: { main: reading(60 * 8, 650_000, 650) } }, // −18,75 % vs la mesure de 1 h
    ]);
    expect(steps[2]?.events).toEqual([]);
    expect(lpReference(steps[1]!.snapshot.pool!, at(60 * 8))).toEqual({ sqrtK: Math.sqrt(800_000 * 800), at: at(60) });
  });

  it('pool principal changé, pool suivi stable : nouvelle référence sans alerte', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3) } },
      { pool: { main: reading(5, 4e6, 4e3, { address: POOL2, dex: 'orca' }), tracked: reading(5, 1e6, 1e3) } },
      { pool: { main: reading(10, 4e6, 4e3, { address: POOL2, dex: 'orca' }) } },
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot.pool?.address).toBe(POOL2);
    expect(steps[2]?.events).toEqual([]);
  });

  it('rug du pool suivi alors qu’un autre pool devient principal : alerte sur le pool suivi, puis bascule', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3) } },
      { pool: { main: reading(5, 2e5, 2e2, { address: POOL2, dex: 'orca' }), tracked: reading(5, 1e4, 10) } },
      { pool: { main: reading(10, 2e5, 2e2, { address: POOL2, dex: 'orca' }), tracked: reading(10, 1e4, 10) } },
    ]);
    expect(steps[1]?.events.map((event) => event.type)).toEqual(['lp_removed']);
    expect(steps[1]?.snapshot.pool?.address).toBe(POOL);
    expect(steps[2]?.events).toEqual([]);
    expect(steps[2]?.snapshot.pool?.address).toBe(POOL2);
  });

  it('pool suivi plus listé : le nouveau pool principal devient la référence, sans alerte', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3) } },
      { pool: { main: reading(5, 1e3, 1, { address: POOL2 }), tracked: null } },
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot.pool).toMatchObject({ address: POOL2, peakAt: at(5) });
  });

  it('aucun pool listé : le pool précédent est conservé', () => {
    const steps = replay([{ pool: { main: reading(0, 1e6, 1e3) } }, { pool: { main: null, tracked: null } }]);
    expect(steps[1]?.snapshot.pool?.observedAt).toBe(at(0));
    const empty = replay([{ pool: { main: null } }]);
    expect(empty[0]?.snapshot.pool).toBeNull();
  });

  it('première lecture sur le seul pool suivi', () => {
    const [first] = replay([{ pool: { main: null, tracked: reading(0, 1e6, 1e3) } }]);
    expect(first?.snapshot.pool?.address).toBe(POOL);
  });

  it('même lecture rejouée (même instant) : rien ne change', () => {
    const steps = replay([{ pool: { main: reading(0, 1e6, 1e3) } }, { pool: { main: reading(0, 1e5, 1e2) } }]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[1]?.snapshot.pool?.base).toBe(1e6);
  });

  it('courbe de liaison (pump.fun) : ni alerte LP, ni blocage à la migration', () => {
    const steps = replay([
      { pool: { main: reading(0, 1e6, 1e3, { dex: 'pumpfun' }) } },
      { pool: { main: reading(5, 1e3, 1, { dex: 'pumpfun' }) } },
      { pool: { main: reading(10, 5e5, 5e2, { address: POOL2, dex: 'pumpswap' }), tracked: reading(10, 0, 0, { dex: 'pumpfun' }) } },
    ]);
    expect(steps[1]?.events).toEqual([]);
    expect(steps[2]?.events).toEqual([]);
    expect(steps[2]?.snapshot.pool?.address).toBe(POOL2);
  });

  it('référence nulle (pool vide) : aucune division, aucun événement', () => {
    const steps = replay([{ pool: { main: reading(0, 0, 0, { liquidityUsd: null }) } }, { pool: { main: reading(5, 0, 0, { liquidityUsd: null }) } }]);
    expect(steps[1]?.events).toEqual([]);
  });
});

describe('holder de plus de 5 % qui vend', () => {
  const base: Array<[string, string, number]> = [
    [H1, TA1, 100_000_000], // 10 %
    [H2, TA2, 60_000_000], // 6 %
    [H3, TA3, 40_000_000], // 4 % : sous le seuil, jamais surveillé
  ];

  it.each<[string, Array<[string, string, number]>, Array<{ owner: string; afterPct: number | null; soldPctOfPosition: number }>]>([
    ['aucun mouvement', base, []],
    ['H1 cède 40 % de sa position (10 % → 6 %)', [[H1, TA1, 60_000_000], [H2, TA2, 60_000_000], [H3, TA3, 40_000_000]], [{ owner: H1, afterPct: 6, soldPctOfPosition: 40 }]],
    ['H1 cède 15 % (1,5 point) : seuil des points atteint', [[H1, TA1, 85_000_000], [H2, TA2, 60_000_000], [H3, TA3, 40_000_000]], [{ owner: H1, afterPct: 8.5, soldPctOfPosition: 15 }]],
    ['H2 cède 10 % (0,6 point) : sous les deux seuils', [[H1, TA1, 100_000_000], [H2, TA2, 54_000_000], [H3, TA3, 40_000_000]], []],
    ['H3 (4 %) vend tout : non surveillé', [[H1, TA1, 100_000_000], [H2, TA2, 60_000_000], [TA4, TA4, 1_000_000]], []],
    ['H2 sort du top : borne prudente au plus petit compte', [[H1, TA1, 100_000_000], [H3, TA3, 40_000_000], [TA4, TA4, 10_000_000]], [{ owner: H2, afterPct: null, soldPctOfPosition: 83.33 }]],
    ['H1 répartit sur deux comptes (agrégé par propriétaire) : rien', [[H1, TA1, 50_000_000], [H1, TA4, 50_000_000], [H2, TA2, 60_000_000], [H3, TA3, 40_000_000]], []],
    ['H1 achète : rien', [[H1, TA1, 150_000_000], [H2, TA2, 60_000_000], [H3, TA3, 40_000_000]], []],
  ])('%s', (_name, nextTop, expected) => {
    const steps = replay([{ holders: holders(0, base) }, { holders: holders(30, nextTop) }]);
    const events = steps[1]?.events ?? [];
    expect(events.map((event) => (event.type === 'holder_sold' ? { owner: event.payload.owner, afterPct: event.payload.afterPct, soldPctOfPosition: event.payload.soldPctOfPosition } : null))).toEqual(expected);
    for (const event of events) {
      expect(event).toMatchObject({ severity: 'warn', detectedAt: at(30) });
      expect(event.dedupeKey).toBe(`holder_sold:${event.type === 'holder_sold' ? event.payload.owner : ''}:${at(0)}`);
    }
  });

  it('top vide après un top non vide : lecture douteuse, aucune alerte', () => {
    const steps = replay([{ holders: holders(0, base) }, { holders: holders(30, []) }]);
    expect(steps[1]?.events).toEqual([]);
  });

  it('offre nulle : aucune part calculable, aucune alerte', () => {
    const steps = replay([{ holders: holders(0, base, 0) }, { holders: holders(30, [[H1, TA1, 1]], 0) }]);
    expect(steps[1]?.events).toEqual([]);
  });

  it('seuils configurables (banc) : 1 seul point suffit à 0,6 point si le seuil est 0,5', () => {
    const previous = snapshot({ holders: holders(0, base) });
    const next = mergeWatchSnapshot(previous, { mint: MINT, holders: holders(30, [[H1, TA1, 100_000_000], [H2, TA2, 54_000_000], [H3, TA3, 40_000_000]]) });
    const events = detectWatchEvents(previous, next, { ...WATCH_EVENT_THRESHOLDS, holderSellMinSupplyPts: 0.5 });
    expect(events.map((event) => event.type)).toEqual(['holder_sold']);
  });
});

describe('ordre stable', () => {
  it('verdict, autorités, LP, holders', () => {
    const steps = replay([
      { verdict: verdict(0, 'safe'), authorities: authorities(0, false, false), pool: { main: reading(0, 1e6, 1e3) }, holders: holders(0, [[H1, TA1, 100_000_000]]) },
      { verdict: verdict(30, 'danger'), authorities: authorities(30, true, true), pool: { main: reading(30, 1e5, 1e2) }, holders: holders(30, [[H1, TA1, 10_000_000]]) },
    ]);
    expect(steps[1]?.events.map((event) => event.type)).toEqual(['verdict_degraded', 'mint_reactivated', 'freeze_reactivated', 'lp_removed', 'holder_sold']);
  });
});
