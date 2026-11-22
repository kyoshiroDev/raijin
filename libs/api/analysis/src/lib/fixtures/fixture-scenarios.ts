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
