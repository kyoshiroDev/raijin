import type { Fixture } from '@raijin/api-solana/testing';

/**
 * Scénarios de fixtures en séquence (`ANALYSIS_FIXTURES=1` seulement, jamais en production) : une
 * étape courante par scénario (`watch-lp-removed`, `watch-mint-reactivated`, `watch-holder-sold`…),
 * avancée par les tests e2e (`POST internal/fixtures/:scenario`). À l'étape N, une requête est servie
 * par l'étape la plus récente ≤ N qui la connaît, sinon par les fixtures de base. Les scénarios portent
 * sur des mints distincts : aucun ne masque un autre.
 */
export class FixtureScenarios {
  private readonly steps = new Map<string, number>();

  constructor(
    private readonly sequences: Readonly<Record<string, readonly (readonly Fixture[])[]>>,
    private readonly base: readonly Fixture[],
  ) {}

  names(): string[] {
    return Object.keys(this.sequences).sort();
  }

  /** Nombre d'étapes d'un scénario, `null` s'il est inconnu. */
  size(scenario: string): number | null {
    return Object.hasOwn(this.sequences, scenario) ? (this.sequences[scenario]?.length ?? 0) : null;
  }

  step(scenario: string): number {
    return this.steps.get(scenario) ?? 0;
  }

  /** Place un scénario à l'étape `step` ; `false` si le scénario ou l'étape n'existe pas. */
  goTo(scenario: string, step: number): boolean {
    const size = this.size(scenario);
    if (size === null || !Number.isInteger(step) || step < 0 || step >= size) return false;
    this.steps.set(scenario, step);
    return true;
  }

  reset(): void {
    this.steps.clear();
  }

  /** Fixtures servies à l'instant (étapes courantes, plus récentes d'abord, puis la base). */
  current(): Fixture[] {
    const active = this.names().flatMap((name) => {
      const sequence = this.sequences[name] ?? [];
      return sequence.slice(0, this.step(name) + 1).reverse().flat();
    });
    return [...active, ...this.base];
  }
}

/** Mint du scénario « holder vendeur » (`watch-holder-sold`) : seuls les comptes de holders y sont enregistrés. */
export const HOLDER_SOLD_MINT = '7kyyXC5ZbjLDGucQA2ucEHb6wrq8fiWxDRCcf2HWzQu4';
/** Offre brute du scénario (1 000 000 000), base des parts de chaque holder. */
const HOLDER_SOLD_SUPPLY = '1000000000';

/**
 * Compte de mint synthétique du scénario `watch-holder-sold` (le scénario n'enregistre que le top 20
 * et les propriétaires) : dérivé du compte de mint révoqué de `watch-mint-reactivated` (étape 0),
 * adresse et offre remplacées. Sert à l'analyse (création du suivi) et à la lecture de l'offre par la
 * passe holders. Ne concerne que ce mint : aucun autre verdict n'est modifié. `null` si la source manque.
 */
export function holderSoldMintFixture(sequences: Readonly<Record<string, readonly (readonly Fixture[])[]>>): Fixture | null {
  const template = sequences['watch-mint-reactivated']?.[0]?.find(
    (fixture) => fixture.source === 'solana-rpc' && fixture.request.rpcMethod === 'getAccountInfo',
  );
  if (!template || !Array.isArray(template.request.params)) return null;
  const [, options] = template.request.params as [unknown, unknown];
  const body = JSON.parse(JSON.stringify(template.body).replace(/"supply":"\d+"/g, `"supply":"${HOLDER_SOLD_SUPPLY}"`)) as unknown;
  return { ...template, body, request: { ...template.request, params: [HOLDER_SOLD_MINT, options] } };
}
