import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { parseTokenRow, type TokenRow } from '@raijin/bench-web-logic';
import { TokenCard } from './token-card';

function token(over: Record<string, unknown> = {}): TokenRow {
  const t = parseTokenRow({
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'GTA6',
    name: 'GTA VI',
    flags: [],
    liquidity_usd: 85_000,
    liquidity_dex_usd: 85_000,
    ...over,
  });
  if (!t) throw new Error('invalid fixture');
  return t;
}

function render(t: TokenRow, stake?: number) {
  const fixture = TestBed.createComponent(TokenCard);
  fixture.componentRef.setInput('token', t);
  if (stake !== undefined) fixture.componentRef.setInput('stake', stake);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const line = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-roundtrip]');

describe('TokenCard', () => {
  it('shows the effective liquidity with the sources button', () => {
    const el = render(token({ liquidity_effective_usd: 42_000 }));
    expect(el.querySelector('[data-liquidity-value]')?.textContent?.trim()).toBe('42,0\u00a0k$');
    expect(el.querySelector('button[aria-label="Détail des sources de liquidité"]')).not.toBeNull();
  });

  it('shows the net round-trip cost in SOL for the default 0.05 SOL stake, with the recoverable rent', () => {
    // 0.05 SOL: 0.5 + 1.9 × 0.5 = 1.45 % → 0.000725 + 0.0002 network = 0.000925 SOL → 1.85 %
    const el = render(token({ roundtrip_cost_pct: 2.4, roundtrip_fee_pct: 0.5 }));
    const cost = el.querySelector('[data-roundtrip-cost]');
    expect(cost?.textContent?.trim()).toBe('Coût aller-retour : 0,0009 SOL (1,9 %) (coût faible)');
    expect(cost?.querySelector('.sr-only')?.textContent?.trim()).toBe('(coût faible)');
    expect(cost?.classList).toContain('text-bull');
    expect(el.querySelector('[data-roundtrip-rent]')?.textContent?.trim()).toBe('· +0,002 SOL de rent récupérable');
  });

  it("uses the user's stake (0.05 SOL at 2.2 % → 0,0013 SOL, 2,6 %)", () => {
    const el = render(token({ roundtrip_cost_pct: 2.2 }), 0.05);
    // no fee part: 2.2 × 0.5 = 1.1 % → 0.00055 + 0.0002 = 0.00075 SOL → 1.5 %
    expect(el.querySelector('[data-roundtrip-cost]')?.textContent).toContain('Coût aller-retour : 0,0008 SOL (1,5 %)');
    const big = render(token({ roundtrip_cost_pct: 2.4, roundtrip_fee_pct: 0.5 }), 0.3);
    expect(big.querySelector('[data-roundtrip-cost]')?.textContent).toContain('Coût aller-retour : 0,019 SOL (6,3 %)');
    expect(big.querySelector('[data-roundtrip-cost]')?.classList).toContain('text-warn');
    expect(big.querySelector('[data-roundtrip-cost] .sr-only')?.textContent).toContain('coût modéré'); // not colour only
  });

  it('colours by net cost / stake: green < 3 %, orange 3–8 %, red > 8 % (2.99 / 3 / 8 / 8.01)', () => {
    // stake 0.1 SOL (the quote itself): net % = cost % + 0.2 % of network fees
    const cases: [number, string, string][] = [
      [2.79, 'text-bull', 'coût faible'],
      [2.8, 'text-warn', 'coût modéré'],
      [7.8, 'text-warn', 'coût modéré'],
      [7.81, 'text-bear', 'coût élevé'],
    ];
    for (const [pct, cls, sr] of cases) {
      const cost = render(token({ roundtrip_cost_pct: pct }), 0.1).querySelector('[data-roundtrip-cost]');
      expect(cost?.classList).toContain(cls);
      expect(cost?.querySelector('.sr-only')?.textContent).toContain(sr);
    }
  });

  it('says « inconnu » in muted when there is no quote, rent still shown', () => {
    const el = render(token(), 0.5);
    const cost = el.querySelector('[data-roundtrip-cost]');
    expect(cost?.textContent?.trim()).toBe('Coût aller-retour : inconnu');
    expect(cost?.classList).toContain('text-muted');
    expect(cost?.querySelector('.sr-only')).toBeNull();
    expect(el.querySelector('[data-roundtrip-rent]')?.textContent?.trim()).toBe('· +0,002 SOL de rent récupérable');
  });

  it('never cuts the round-trip line: cost stays whole, rent wraps instead of truncating', () => {
    const el = render(token({ roundtrip_cost_pct: 2.4 }));
    expect(line(el)?.classList).toContain('flex-wrap');
    expect(line(el)?.classList).not.toContain('whitespace-nowrap');
    expect(el.querySelector('[data-roundtrip-cost]')?.classList).toContain('shrink-0');
    expect(el.querySelector('[data-roundtrip-cost]')?.classList).toContain('whitespace-nowrap');
    expect(el.querySelector('[data-roundtrip-rent]')?.classList).not.toContain('truncate');
  });

  it('shows the data-confidence badge as text, nothing when unknown', () => {
    expect(render(token({ data_confidence: 'high' })).querySelector('[data-confidence]')?.textContent?.trim()).toBe('Données fiables');
    const medium = render(token({ data_confidence: 'medium' })).querySelector('[data-confidence]');
    expect(medium?.textContent?.trim()).toBe('Données partielles');
    expect(medium?.classList).toContain('text-warn');
    const low = render(token({ data_confidence: 'low' })).querySelector('[data-confidence]');
    expect(low?.textContent?.trim()).toBe('Données peu fiables');
    expect(low?.classList).toContain('text-bear');
    expect(render(token()).querySelector('[data-confidence]')).toBeNull();
  });

  it('keeps the liquidity button clickable above the stretched card button', () => {
    const el = render(token());
    expect(el.querySelector('app-liquidity-info')?.classList).toContain('pointer-events-auto');
  });

  it('fills its grid cell and pushes the actions to the bottom so copy buttons line up', () => {
    const el = render(token());
    expect(el.classList).toContain('block');
    expect(el.classList).toContain('h-full');
    const article = el.querySelector('article');
    for (const cls of ['h-full', 'flex', 'flex-col']) expect(article?.classList).toContain(cls);
    expect(el.querySelector('article > div')?.classList).toContain('flex-1');
    const actions = el.querySelector('[data-actions]');
    expect(actions?.classList).toContain('mt-auto');
    expect(actions?.querySelector('app-copy-address')).not.toBeNull();
  });

  it('shows the key numbers grid (price, MC, liquidity, 1 h, 24 h) with muted labels and a 6 h sparkline', () => {
    const el = render(token({ price_usd: 0.0234, market_cap: 1_234_567, change_1h: 12.3, change_24h: -4, spark_6h: [1, 1.2, 1.1] }));
    const labels = [...el.querySelectorAll('[data-stats] dt')].map((d) => d.textContent?.trim());
    expect(labels).toEqual(['Prix', 'MC', 'Liquidité', '1 h', '24 h', '6 h']);
    for (const dt of el.querySelectorAll('[data-stats] dt')) expect(dt.classList).toContain('text-muted');
    expect(el.querySelector('[data-stats]')?.classList).toContain('tabular-nums');
    expect(el.querySelector('[data-stats]')?.textContent).toContain('1,23\u00a0M$');
    expect(el.querySelector('[data-spark-cell] svg[aria-hidden="true"]')).not.toBeNull();
    expect(el.querySelector('[data-spark-cell] .sr-only')?.textContent?.trim()).toBe('Variation 6 h : +10 %');
    const tiny = render(token({ price_usd: 0.000000001234 })).querySelector('[data-price]');
    expect(tiny?.querySelector('[aria-hidden="true"]')?.textContent).toBe('0,0₈1234\u00a0$');
    expect(tiny?.querySelector('.sr-only')?.textContent).toBe('0,000000001234\u00a0$');
    const none = render(token()).querySelector('[data-spark-cell]');
    expect(none?.querySelector('svg')).toBeNull();
    expect(none?.querySelector('dd')?.textContent?.trim()).toBe('–');
  });

  it('uses the mint-coloured generated avatar when there is no logo, symbol rendered as text', () => {
    const el = render(token({ symbol: '<img src=x onerror=alert(1)>', image_url: 'javascript:alert(1)' }));
    const avatar = el.querySelector('app-token-avatar [data-avatar-fallback]');
    expect(avatar?.textContent?.trim()).toBe('I');
    expect((avatar as HTMLElement | null)?.style.backgroundColor).not.toBe('');
    expect(el.querySelector('app-token-avatar img')).toBeNull();
    expect(el.querySelector('h2')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(el.querySelector('h2')?.children.length).toBe(0);
  });

  it('reserves the signals area even without flags', () => {
    const signals = render(token()).querySelector('[data-signals]');
    expect(signals).not.toBeNull();
    expect(signals?.classList).toContain('min-h-5');
    expect(signals?.querySelectorAll('li').length).toBe(0);
  });

  it('shows at most 2 flags then « +N », the full list staying in the detail', () => {
    const el = render(token({ flags: ['LP non verrouillée', 'Top 10 élevé', 'Jeune paire', 'Volume suspect'] }));
    expect(el.querySelectorAll('[data-signals] li:not([data-more-flags])').length).toBe(2);
    expect(el.querySelector('[data-more-flags] [aria-hidden="true"]')?.textContent?.trim()).toBe('+2');
    expect(el.querySelector('[data-more-flags] .sr-only')?.textContent?.trim()).toBe('2 autres signaux, voir la fiche');
    const two = render(token({ flags: ['a', 'b'] }));
    expect(two.querySelectorAll('[data-signals] li').length).toBe(2);
    expect(two.querySelector('[data-more-flags]')).toBeNull();
  });

  it('gives press feedback only without reduced motion (motion-safe variants)', () => {
    const el = render(token());
    expect(el.querySelector('article')?.className).toContain('motion-safe:has-[[data-open]:active]:scale-[0.98]');
    expect(el.querySelector('[data-open]')?.className).toContain('motion-safe:active:brightness-110');
  });

  it('shows the factual badges: age, « Calme », « Sécurité OK » (no score, no entry zone)', () => {
    const el = render(
      token({
        pair_created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        change_1h: 40,
        buys_1h: 100,
        sells_1h: 100,
        mint_authority_disabled: true,
        freeze_authority_disabled: true,
        top10_pct: 18,
        roundtrip_cost_pct: 2.4,
      }),
    );
    expect(el.querySelector('[data-badge="age"]')?.textContent?.trim()).toBe('Âge 3 h');
    expect(el.querySelector('[data-badge="calm"]')?.textContent).toContain('Calme');
    expect(el.querySelector('[data-badge="safety-ok"]')?.textContent).toContain('Sécurité OK');
    expect(el.querySelector('app-score-ring, app-zone-range-bar, [data-zone-line], [data-p-x3], [data-rr]')).toBeNull();
    expect(el.textContent).not.toContain('/100');
  });

  it('shows « Frénésie » and « Sécurité KO » with the failed rules as screen-reader text', () => {
    const el = render(
      token({
        pair_created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        change_1h: 220,
        buys_1h: 10,
        sells_1h: 10,
        mint_authority_disabled: false,
        freeze_authority_disabled: true,
        top10_pct: 40,
        flags: ['Structure cassée'],
      }),
    );
    expect(el.querySelector('[data-badge="frenzy"]')?.textContent).toContain('Frénésie');
    const ko = el.querySelector('[data-badge="safety-ko"]');
    // Contraste AA : texte fg sur teinte bear (bear/15 + text-bear = 4,39:1), sémantique via l'icône et le liseré bear.
    expect(ko?.classList).toContain('text-fg');
    expect(ko?.classList).toContain('ring-bear/50');
    expect(ko?.querySelector('app-icon')?.classList).toContain('text-bear');
    expect(ko?.querySelector('.sr-only')?.textContent).toContain('Autorité de mint active ; Top 10 holders à 40,0 % (max 25 %) ; Coût aller-retour inconnu ; Structure cassée');
  });

  it('shows no momentum badge on an old pair or when neither calm nor frenzy', () => {
    const old = render(token({ pair_created_at: new Date(Date.now() - 72 * 3_600_000).toISOString(), change_1h: 40, buys_1h: 1, sells_1h: 1 }));
    expect(old.querySelector('[data-badge="calm"], [data-badge="frenzy"]')).toBeNull();
    expect(old.querySelector('[data-badge="age"]')?.textContent?.trim()).toBe('Âge 3 j');
    const neither = render(token({ pair_created_at: new Date(Date.now() - 3_600_000).toISOString(), change_1h: -12, buys_1h: 1, sells_1h: 1 }));
    expect(neither.querySelector('[data-badge="calm"], [data-badge="frenzy"]')).toBeNull();
  });
});
