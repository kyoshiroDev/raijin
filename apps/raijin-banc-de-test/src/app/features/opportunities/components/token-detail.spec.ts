import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TokenRow } from '@raijin/bench-web-logic';
import { mockBench, ok, snapshotRows } from './price-chart-test-data';
import { TokenDetail } from './token-detail';

const HOSTILE = '<img src=x onerror=alert(1)>';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAIR = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const token = (over: Partial<TokenRow> = {}): TokenRow => ({
  mint: MINT,
  symbol: 'GTA6',
  name: 'GTA VI',
  pair_address: PAIR,
  dex_id: 'raydium',
  image_url: null,
  website_url: null,
  x_url: null,
  telegram_url: null,
  price_usd: 0.00012,
  market_cap: 1_200_000,
  liquidity_usd: 85_000,
  liquidity_jup_usd: null,
  volume_24h: 430_000,
  change_1h: 4.2,
  change_24h: -12.5,
  buys_1h: 120,
  sells_1h: 80,
  pair_created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  flags: [],
  mint_authority_disabled: true,
  freeze_authority_disabled: false,
  top10_pct: 22.4,
  holder_count: 1520,
  organic_score: 64,
  first_seen_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  liquidity_dex_usd: null,
  liquidity_gecko_usd: null,
  liquidity_effective_usd: null,
  liquidity_divergence: null,
  roundtrip_cost_pct: null,
  roundtrip_fee_pct: null,
  buy_impact_pct: null,
  lp_locked_pct: null,
  rugcheck_score: null,
  rugcheck_dangers: [],
  price_jup_usd: null,
  price_gecko_usd: null,
  data_confidence: null,
  quote_at: null,
  rugcheck_at: null,
  enriched_at: null,
  narrative: null,
  narrative_rank: null,
  insiders_detected: null,
  creator_rug_history: null,
  ...over,
});

function render(t: TokenRow, stake?: number, eurPerSol?: number | null) {
  const fixture = TestBed.createComponent(TokenDetail);
  fixture.componentRef.setInput('token', t);
  if (stake !== undefined) fixture.componentRef.setInput('stake', stake);
  if (eurPerSol !== undefined) fixture.componentRef.setInput('eurPerSol', eurPerSol);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TokenDetail', () => {
  let sb: ReturnType<typeof mockBench>;

  beforeEach(() => {
    // The price chart reads token_snapshots / alert_log / paper_positions: never the real client in tests.
    sb = mockBench({ token_snapshots: ok(snapshotRows(6)) });
    TestBed.configureTestingModule({ providers: sb.providers });
  });

  it('shows the « Signaux » badges first, then the price chart for this mint (no entry zone section)', async () => {
    const fixture = TestBed.createComponent(TokenDetail);
    fixture.componentRef.setInput('token', token());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const chart = el.querySelector('[data-price-chart]');
    const signals = el.querySelector('[data-detail-signals]');
    expect(chart).not.toBeNull();
    expect(signals).not.toBeNull();
    if (chart && signals) expect(signals.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from(el.querySelectorAll('h3')).some((h) => h.textContent?.includes('Zone d’entrée'))).toBe(false);
    expect(sb.callsOf('token_snapshots').map((c) => c.params)).toEqual([{ mint: MINT }]);
    expect(el.querySelector('[data-chart-surface]')?.getAttribute('role')).toBe('img');
  });

  it('renders a hostile symbol, name and flag as plain text', () => {
    const el = render(token({ symbol: HOSTILE, name: HOSTILE, flags: [HOSTILE] }));
    expect(el.textContent).toContain(HOSTILE);
    expect(el.querySelector('img[src="x"]')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
  });

  it('shows market and security data, no score, zone, TP or plan', () => {
    const text = render(token()).textContent ?? '';
    for (const label of ['Prix', 'Market cap', 'Liquidité', 'Volume 24 h']) expect(text).toContain(label);
    for (const gone of ['Zone basse', 'Invalidation', 'TP1', 'Plan de sortie', '/100', 'Modèle ×3', 'R/R']) expect(text).not.toContain(gone);
    expect(text).toContain('Autorité de mint');
    expect(text).toContain('Active'); // freeze authority still active
    expect(text).toContain('22,4 %');
    expect(text).toContain('64 / 100');
    expect(text).toContain('+4,2 %');
  });

  it('ignores a lower Jupiter liquidity (control value, v5) and keeps the DexScreener value', () => {
    const text = render(token({ liquidity_usd: 15_600, liquidity_jup_usd: 6_900 })).textContent ?? '';
    expect(text).toContain('15,6\u00a0k$');
    expect(text).not.toContain('Jupiter)');
    expect(text).not.toContain('prudente');
  });

  it('shows the DexScreener liquidity without hint when Jupiter is higher or unknown', () => {
    for (const jup of [null, 120_000]) {
      const text = render(token({ liquidity_usd: 85_000, liquidity_jup_usd: jup })).textContent ?? '';
      expect(text).toContain('85,0\u00a0k$');
      expect(text).not.toContain('prudente');
      expect(text).not.toContain('médiane');
    }
  });

  it('shows the effective liquidity when the backend provides it, labelled as a 2-source median', () => {
    const el = render(token({ liquidity_usd: 85_000, liquidity_gecko_usd: 40_000, liquidity_effective_usd: 62_500 }));
    expect(el.querySelector('[data-liquidity-value]')?.textContent?.trim()).toBe('62,5\u00a0k$');
    expect(el.textContent).toContain('Liquidité (médiane 2 sources)');
  });

  it('breaks the round trip down in SOL for the user stake, with the buy impact and the estimation note', () => {
    // 0.3 SOL: 6.2 % → 0.0186 slippage + 0.0002 network + 0.00204 rent = 0.02084 paid, 0.0188 net (6.27 %)
    const el = render(token({ roundtrip_cost_pct: 2.4, roundtrip_fee_pct: 0.5, buy_impact_pct: 0.9 }), 0.3);
    const box = el.querySelector('[data-roundtrip-breakdown]');
    const txt = (sel: string) =>
      Array.from(box?.querySelector(sel)?.children ?? [])
        .map((c) => c.textContent?.replace(/\s+/g, ' ').trim())
        .join(' ');
    expect(box?.textContent).toContain('Coût aller-retour pour 0,3 SOL (estimé)');
    expect(txt('[data-cost-slippage]')).toBe('Slippage et frais de pool 0,019 SOL');
    expect(txt('[data-cost-network]')).toBe('Frais réseau (2 × 0,0001 SOL) 0,0002 SOL');
    expect(txt('[data-cost-rent]')).toContain('Rent du compte token 0,002 SOL');
    expect(txt('[data-cost-rent]')).toContain(
      'Récupérable en fermant le compte du token après la vente (Phantom / Solflare : Burn / Close token account).',
    );
    expect(txt('[data-cost-paid]')).toBe('Total payé 0,021 SOL');
    expect(txt('[data-cost-net]')).toContain('Total net (après récupération du rent) 0,019 SOL');
    expect(box?.querySelector('[data-cost-net] dd')?.classList).toContain('text-warn');
    expect(box?.querySelector('[data-break-even]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Le token doit monter d’au moins 6,3 % pour rentrer dans tes frais.',
    );
    const text = el.textContent ?? '';
    expect(text).toContain('Impact de prix à l’achat (0,1 SOL) : 0,9 %');
    expect(text).toContain('Estimation à partir d’un devis Jupiter de 0,1 SOL ; l’impact de prix croît avec la mise.');
  });

  it('adds the € equivalent when the rate is known, none otherwise', () => {
    const t = token({ roundtrip_cost_pct: 2.2 });
    // 0.05 SOL: 1.1 % → 0.00055 slippage; at 160 €/SOL = 0.088 €
    const withEur = render(t, 0.05, 160).querySelector('[data-cost-slippage]')?.textContent ?? '';
    expect(withEur).toContain('0,0006 SOL (≈ 0,09 €)');
    expect(render(t, 0.05, 160).querySelector('[data-cost-network]')?.textContent).toContain('0,0002 SOL (≈ 0,03 €)');
    for (const rate of [null, undefined]) {
      expect(render(t, 0.05, rate).querySelector('[data-roundtrip-breakdown]')?.textContent).not.toContain('€');
    }
  });

  it('does not call the 0.1 SOL quote an estimate', () => {
    const text = render(token({ roundtrip_cost_pct: 9 }), 0.1).textContent ?? '';
    expect(text).toContain('Coût aller-retour pour 0,1 SOL');
    expect(text).not.toContain('(estimé)');
    expect(text).toContain('Devis Jupiter pour 0,1 SOL (achat puis revente immédiate).');
    expect(text).toContain('coût élevé');
  });

  it('shows an unknown round trip (network fees and rent still listed) and buy impact', () => {
    const el = render(token());
    const box = el.querySelector('[data-roundtrip-breakdown]');
    expect(box?.textContent).toContain('Coût aller-retour pour 0,05 SOL (estimé)');
    expect(box?.querySelector('[data-cost-slippage] dd')?.textContent?.trim()).toBe('inconnu');
    expect(box?.querySelector('[data-cost-paid] dd')?.textContent?.trim()).toBe('inconnu');
    expect(box?.querySelector('[data-cost-net] dd')?.textContent?.trim()).toBe('inconnu');
    expect(box?.querySelector('[data-cost-net] dd')?.classList).toContain('text-muted');
    expect(box?.querySelector('[data-cost-network] dd')?.textContent?.trim()).toBe('0,0002 SOL');
    expect(box?.querySelector('[data-cost-rent] dd')?.textContent?.trim()).toBe('0,002 SOL');
    expect(box?.querySelector('[data-break-even]')?.textContent).toContain('Seuil de rentabilité inconnu');
    expect(el.textContent).toContain('Impact de prix à l’achat (0,1 SOL) : inconnu');
  });

  it('shows the confidence badge, RugCheck data and the enrichment age', () => {
    const el = render(
      token({
        data_confidence: 'low',
        lp_locked_pct: 85,
        rugcheck_score: 1200,
        rugcheck_dangers: [HOSTILE, 'Mutable metadata'],
        rugcheck_at: new Date().toISOString(),
        enriched_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
    );
    const text = el.textContent ?? '';
    expect(el.querySelector('[data-confidence]')?.textContent?.trim()).toBe('Données peu fiables');
    expect(text).toContain('LP verrouillée');
    expect(text).toContain('85 %');
    expect(text).toContain('Score RugCheck');
    expect(text).toContain('1200');
    const dangers = el.querySelector('ul[aria-label="Dangers signalés par RugCheck"]');
    expect(dangers?.textContent).toContain(HOSTILE);
    expect(dangers?.textContent).toContain('Mutable metadata');
    expect(el.querySelector('img[src="x"]')).toBeNull();
    expect(el.querySelector('[data-enriched]')?.textContent?.trim()).toBe('Enrichi il y a 3 min');
  });

  it('says when RugCheck and the enrichment have not run yet', () => {
    const el = render(token());
    expect(el.querySelector('[data-confidence]')).toBeNull();
    expect(el.textContent).toContain('RugCheck : pas encore analysé.');
    expect(el.querySelector('[data-enriched]')?.textContent?.trim()).toBe('Pas encore enrichi (sources croisées)');
  });

  it('only renders safe https links, in a new tab without opener/referrer', () => {
    const el = render(
      token({
        website_url: 'javascript:alert(1)',
        x_url: 'https://evil.example/x',
        telegram_url: 'https://t.me/raijin_ok',
      }),
    );
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a'));
    const hrefs = links.map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain(`https://dexscreener.com/solana/${PAIR}`);
    expect(hrefs).toContain('https://t.me/raijin_ok');
    expect(hrefs.some((h) => h.includes('evil.example'))).toBe(false);
    expect(hrefs.some((h) => h.startsWith('javascript:'))).toBe(false);
    for (const a of links) {
      expect(a.getAttribute('href')?.startsWith('https://')).toBe(true);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('skips the DexScreener link when the pair address is not a valid address', () => {
    const el = render(token({ pair_address: '../../evil' }));
    const hrefs = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.includes('dexscreener'))).toBe(false);
  });

  it('offers a « Paper trade » (simulation) button, enabled when a price is known', () => {
    const btn = render(token()).querySelector<HTMLButtonElement>('[data-paper-trade-button]');
    expect(btn?.textContent).toContain('Paper trade');
    expect(btn?.textContent).toContain('simulation');
    expect(btn?.disabled).toBe(false);
    const none = render(token({ price_usd: 0 })).querySelector<HTMLButtonElement>('[data-paper-trade-button]');
    expect(none?.disabled).toBe(true);
  });

  it('uses the copy-address component (4/4 check) for the mint', () => {
    const el = render(token());
    const copy = el.querySelector('app-copy-address');
    expect(copy?.textContent).toContain('EPjF…Dt1v');
  });

  it('ignores images from non-allowlisted hosts', () => {
    const el = render(token({ image_url: 'https://evil.example/logo.png' }));
    expect(el.querySelector('img')).toBeNull();
    const ok = render(token({ image_url: 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png' }));
    const img = ok.querySelector('img');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('shows RugCheck insiders and creator history (known / unknown)', () => {
    const bad = render(token({ insiders_detected: true, creator_rug_history: true })).textContent ?? '';
    expect(bad).toContain('Insiders');
    expect(bad).toContain('Détectés');
    expect(bad).toContain('Historique du créateur');
    expect(bad).toContain('Rugs passés signalés');
    const ok = render(token({ insiders_detected: false, creator_rug_history: false })).textContent ?? '';
    expect(ok).toContain('Aucun détecté');
    expect(ok).toContain('Rien de signalé');
    const unknown = render(token()).textContent ?? '';
    expect(unknown).toMatch(/Insiders\s*Inconnu/);
  });

  it('lists the failed safety rules visibly under « Sécurité KO » and shows the narrative pill (hostile text)', () => {
    const el = render(token({ top10_pct: 30, roundtrip_cost_pct: 2.4, flags: ['Structure cassée'], narrative: HOSTILE, narrative_rank: 2 }));
    expect(el.querySelector('[data-badge="safety-ko"]')?.getAttribute('aria-describedby')).toBeTruthy();
    const failures = Array.from(el.querySelectorAll('[data-safety-failures] li')).map((li) => li.textContent?.trim());
    expect(failures).toEqual(['Autorité de gel active', 'Top 10 holders à 30,0 % (max 25 %)', 'Structure cassée']);
    expect(el.querySelector('[data-narrative]')?.textContent?.trim()).toBe(`Narratif ${HOSTILE} · n°2`);
    expect(el.querySelector('img[src="x"]')).toBeNull();
  });

  it('shows « Sécurité OK » without a failure list, the age and the round-trip cost in the signals', () => {
    const el = render(token({ freeze_authority_disabled: true, roundtrip_cost_pct: 2.4 }));
    expect(el.querySelector('[data-badge="safety-ok"]')).not.toBeNull();
    expect(el.querySelector('[data-safety-failures]')).toBeNull();
    const signals = el.querySelector('[data-detail-signals]');
    expect(signals?.querySelector('[data-badge="age"]')?.textContent).toContain('5 h');
    expect(signals?.querySelector('[data-roundtrip-cost]')?.textContent).toContain('Coût aller-retour :');
    expect(el.querySelector('[data-narrative]')).toBeNull();
  });
});
