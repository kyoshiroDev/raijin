import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { mintHue } from '@raijin/bench-web-logic';
import { TokenAvatar } from './token-avatar';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function render(inputs: { imageUrl?: string | null; symbol?: string; mint?: string; size?: number }) {
  const fixture = TestBed.createComponent(TokenAvatar);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('TokenAvatar', () => {
  it('renders an allowlisted logo lazily, without referrer, at a fixed size', () => {
    const { el } = render({ imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png', symbol: 'BONK', mint: MINT, size: 36 });
    const img = el.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img?.getAttribute('width')).toBe('36');
    expect(img?.getAttribute('height')).toBe('36');
    expect(img?.getAttribute('alt')).toBe('');
    expect(el.style.width).toBe('36px');
    expect(el.style.height).toBe('36px');
  });

  it('falls back to a generated avatar for a non-allowlisted or unsafe URL', () => {
    for (const url of ['https://evil.example/x.png', 'javascript:alert(1)', 'http://dd.dexscreener.com/x.png', null]) {
      const { el } = render({ imageUrl: url, symbol: 'BONK', mint: MINT });
      expect(el.querySelector('img')).toBeNull();
      expect(el.querySelector('[data-avatar-fallback]')?.textContent?.trim()).toBe('B');
    }
  });

  it('falls back on image load error', () => {
    const { fixture, el } = render({ imageUrl: 'https://cdn.dexscreener.com/x.png', symbol: 'wif', mint: MINT });
    el.querySelector('img')?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[data-avatar-fallback]')?.textContent?.trim()).toBe('W');
  });

  it('colours the fallback deterministically from the mint (same mint → same colour, neutral without mint)', () => {
    const a = render({ symbol: 'A', mint: MINT }).el.querySelector<HTMLElement>('[data-avatar-fallback]');
    const b = render({ symbol: 'Z', mint: MINT }).el.querySelector<HTMLElement>('[data-avatar-fallback]');
    expect(a?.style.backgroundColor).not.toBe('');
    expect(a?.style.backgroundColor).toBe(b?.style.backgroundColor);
    expect(a?.classList).toContain('text-fg');
    expect(mintHue(MINT)).toBe(mintHue(MINT));
    const neutral = render({ symbol: 'A' }).el.querySelector<HTMLElement>('[data-avatar-fallback]');
    expect(neutral?.style.backgroundColor).toBe('');
    expect(neutral?.classList).toContain('bg-surface-2');
  });

  it('renders a hostile symbol as text only (no element injected)', () => {
    const { el } = render({ symbol: '<img src=x onerror=alert(1)>', mint: MINT });
    expect(el.querySelector('img')).toBeNull();
    const fb = el.querySelector('[data-avatar-fallback]');
    expect(fb?.children.length).toBe(0);
    expect(fb?.textContent?.trim()).toBe('I');
    expect(render({ symbol: '<>$', mint: MINT }).el.querySelector('[data-avatar-fallback]')?.textContent?.trim()).toBe('?');
  });
});
