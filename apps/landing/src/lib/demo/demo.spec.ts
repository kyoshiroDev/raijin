import { describe, expect, it } from 'vitest';
import { evaluateRisk } from '@raijin/shared-risk-engine';
import { buildDemoView, DEMO } from './demo';
import { DEMO_FACTS, DEMO_TOKEN } from './facts';

describe('analyse de démonstration', () => {
  it('est calculée par le moteur de production et reste figée sur Prudence', () => {
    expect(evaluateRisk(DEMO_FACTS).verdict).toBe('warn');
    expect(DEMO.verdict).toBe('warn');
    expect(DEMO.verdictLabel).toBe('Prudence');
  });

  it('montre les statuts OK, Attention et Indisponible sur les 9 contrôles', () => {
    expect(DEMO.checks).toHaveLength(9);
    expect(DEMO.counts).toEqual({ ok: 6, warn: 2, danger: 0, unavailable: 1 });
    expect(DEMO.checks.find((check) => check.id === 'creator_history')?.status).toBe('unavailable');
    expect(DEMO.checks.every((check) => check.summary.length > 0 && check.source.length > 0)).toBe(true);
  });

  it("utilise un token fictif nommé « Exemple », sans adresse Solana réelle", () => {
    expect(DEMO_TOKEN.name).toBe('Exemple');
    expect(DEMO.tokenName).toBe('Exemple');
    expect(DEMO_FACTS.mint).not.toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('suit le moteur : une autorité de mint active donnerait Danger', () => {
    const account = DEMO_FACTS.mintAccount;
    if (!account) throw new Error('compte de mint attendu');
    const view = buildDemoView(evaluateRisk({ ...DEMO_FACTS, mintAccount: { ...account, mintAuthorityActive: true } }));
    expect(view.verdict).toBe('danger');
  });
});
