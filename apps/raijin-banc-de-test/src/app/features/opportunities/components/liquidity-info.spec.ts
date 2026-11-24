import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { parseTokenRow, type TokenRow } from '@raijin/bench-web-logic';
import { LiquidityInfo } from './liquidity-info';

function token(over: Record<string, unknown> = {}): TokenRow {
  const t = parseTokenRow({
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'GTA6',
    flags: [],
    liquidity_usd: 85_000,
    liquidity_dex_usd: 85_000,
    ...over,
  });
  if (!t) throw new Error('invalid fixture');
  return t;
}

function setup(t: TokenRow, inline = false) {
  const fixture = TestBed.createComponent(LiquidityInfo);
  fixture.componentRef.setInput('token', t);
  fixture.componentRef.setInput('inline', inline);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = () => el.querySelector('button') as HTMLButtonElement;
  const panel = () => el.querySelector<HTMLElement>('[role="group"]');
  const press = (key: string, target: Element = button()) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  };
  const click = () => {
    button().click();
    fixture.detectChanges();
  };
  return { fixture, el, button, panel, press, click };
}

const ENRICHED = {
  liquidity_jup_usd: 60_000,
  liquidity_gecko_usd: 75_000,
  liquidity_effective_usd: 80_000, // median of DexScreener 85 k$ and GeckoTerminal 75 k$
  liquidity_divergence: 0.13,
};

describe('LiquidityInfo', () => {
  it('shows the effective liquidity and an accessible collapsed disclosure button (≥ 44 px)', () => {
    const { el, button, panel } = setup(token(ENRICHED));
    expect(el.querySelector('[data-liquidity-value]')?.textContent?.trim()).toBe('$80.0 k');
    expect(button().getAttribute('aria-label')).toBe('Détail des sources de liquidité');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(button().getAttribute('aria-controls')).toMatch(/^liquidity-sources-\d+$/);
    expect(button().classList).toContain('size-11');
    expect(button().type).toBe('button');
    expect(panel()).toBeNull();
  });

  it('falls back to the median of DexScreener / GeckoTerminal when the effective value is null (Jupiter ignored)', () => {
    const { el } = setup(token({ liquidity_jup_usd: 60_000 }));
    expect(el.querySelector('[data-liquidity-value]')?.textContent?.trim()).toBe('$85.0 k');
    const both = setup(token({ liquidity_jup_usd: 10_000, liquidity_gecko_usd: 75_000 }));
    expect(both.el.querySelector('[data-liquidity-value]')?.textContent?.trim()).toBe('$80.0 k');
  });

  it('opens on tap: lists each source, unknown ones as « inconnue », the median method, Jupiter as control, the divergence', () => {
    const { button, panel, click } = setup(token({ ...ENRICHED, liquidity_jup_usd: null }));
    click();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    const p = panel();
    expect(p?.id).toBe(button().getAttribute('aria-controls'));
    const row = (id: string) => p?.querySelector(`[data-source="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(row('dex')).toBe('DexScreener $85.0 k (utilisée)');
    expect(row('gecko')).toBe('GeckoTerminal $75.0 k (utilisée)');
    expect(row('jup')).toBe('Jupiter contrôle (non utilisé dans les calculs) inconnue');
    expect(p?.textContent).toContain('Valeur retenue : médiane de DexScreener et GeckoTerminal.');
    expect(p?.textContent).not.toContain('la plus basse');
    expect(p?.textContent).toContain('Écart DexScreener / GeckoTerminal : 13 %');
    expect(p?.querySelector('[data-incoherent]')).toBeNull();
  });

  it('marks a known Jupiter value as control, never as used', () => {
    const { panel, click } = setup(token(ENRICHED));
    click();
    const jup = panel()?.querySelector('[data-source="jup"]')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(jup).toBe('Jupiter contrôle (non utilisé dans les calculs) $60.0 k');
  });

  it('says which single source is used before enrichment', () => {
    const { panel, click } = setup(token());
    click();
    expect(panel()?.textContent).toContain('Valeur retenue : DexScreener (seule source exploitable).');
  });

  it('emphasises « Données incohérentes » when the divergence exceeds 50 %', () => {
    const { panel, click, button } = setup(token({ ...ENRICHED, liquidity_divergence: 0.62 }));
    expect(button().classList).toContain('text-bear');
    click();
    const warn = panel()?.querySelector('[data-incoherent]');
    expect(warn?.querySelector('strong')?.textContent).toBe('Données incohérentes');
    expect(warn?.classList).toContain('text-bear');
    expect(warn?.textContent).toContain('62 %');
  });

  it('says the divergence is unknown before enrichment', () => {
    const { panel, click } = setup(token());
    click();
    expect(panel()?.textContent).toContain('Écart DexScreener / GeckoTerminal : inconnu');
  });

  it('toggles closed on a second tap', () => {
    const { button, panel, click } = setup(token(ENRICHED));
    click();
    click();
    expect(panel()).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes with Escape, returns focus to the button and does not let the Escape reach an enclosing sheet', () => {
    const { button, panel, press, click, fixture } = setup(token(ENRICHED), true);
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    button().focus();
    click();
    const inner = panel()?.querySelector('p') as HTMLElement;
    const event = press('Escape', inner);
    expect(panel()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button());

    // Closed: Escape is left alone (the sheet may close).
    const passthrough = press('Escape');
    expect(passthrough.defaultPrevented).toBe(false);
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outer);
    fixture.destroy();
  });

  it('closes on a tap outside', () => {
    const { panel, click, fixture } = setup(token(ENRICHED));
    click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(panel()).toBeNull();
  });

  it('renders the panel inline in the detail and as a dropdown in the card', () => {
    const card = setup(token(ENRICHED));
    card.click();
    expect(card.panel()?.classList).toContain('absolute');
    const detail = setup(token(ENRICHED), true);
    detail.click();
    expect(detail.panel()?.classList).not.toContain('absolute');
  });
});
