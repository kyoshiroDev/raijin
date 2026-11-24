import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import type { AlertItem } from '@raijin/bench-web-logic/alerts';
import { AlertRow } from './alert-row';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const item = (over: Partial<AlertItem> = {}): AlertItem => ({
  id: 1,
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  sent_at: '2026-11-17T10:00:00Z',
  kind: 'single',
  entry_price: 2,
  target_price: 2.4,
  stop_price: 1.6,
  entry_roundtrip_pct: 2,
  stake_sol: 0.1,
  max_price: 2.5,
  min_price: 1.9,
  last_price: 2.2,
  last_price_at: '2026-11-17T11:57:00Z',
  first_hit: null,
  first_hit_at: null,
  followup_sent_at: null,
  tracking_until: '2026-11-18T10:00:00Z',
  symbol: 'AAA',
  ...over,
});

function render(value: AlertItem): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(AlertRow);
  fixture.componentRef.setInput('item', value);
  fixture.componentRef.setInput('now', NOW);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const badge = (el: HTMLElement) => el.querySelector('[data-status]');

describe('AlertRow (alert outcome)', () => {
  it('shows « Objectif touché » in bull colours with an icon when the target was hit first', () => {
    const b = badge(render(item({ first_hit: 'target' })));
    expect(b?.textContent?.trim()).toBe('Objectif touché');
    expect(b?.getAttribute('data-status')).toBe('target');
    expect(b?.className).toContain('text-bull');
    expect(b?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('shows « Stop touché » in bear colours with an icon when the stop was hit first', () => {
    const b = badge(render(item({ first_hit: 'stop' })));
    expect(b?.textContent?.trim()).toBe('Stop touché');
    expect(b?.className).toContain('text-bear');
    expect(b?.querySelector('svg')).not.toBeNull();
  });

  it('shows a grey « En cours » while tracking, a grey « Suivi terminé » after it with no hit', () => {
    const open = badge(render(item()));
    expect(open?.textContent?.trim()).toBe('En cours');
    expect(open?.className).toContain('text-muted');
    TestBed.resetTestingModule();
    const ended = badge(render(item({ tracking_until: '2026-11-17T11:00:00Z' })));
    expect(ended?.textContent?.trim()).toBe('Suivi terminé');
    expect(ended?.className).toContain('text-muted');
  });

  it('writes entry → high (×) → current (×) with French 2-decimal multiples', () => {
    const el = render(item());
    expect(el.querySelector('[data-outcome]')?.textContent?.trim()).toBe('$2.000 → plus haut $2.500 (×1,25) → actuel $2.200 (×1,10)');
  });

  it('shows no score at all (archived), neither at alert time nor current', () => {
    const el = render(item());
    expect(el.querySelector('[data-entry-score]')).toBeNull();
    expect(el.textContent).not.toContain('Score');
    expect(el.querySelector('.pill:not([data-status])')).toBeNull();
  });

  it('says « Plan non enregistré » without a badge for a legacy row (no entry price)', () => {
    const el = render(item({ entry_price: null, first_hit: 'target' }));
    const legacy = el.querySelector('[data-legacy]');
    expect(legacy?.textContent?.trim()).toBe('Plan non enregistré');
    expect(legacy?.className).toContain('text-muted');
    expect(badge(el)).toBeNull();
    expect(el.querySelector('[data-outcome]')).toBeNull();
    expect(el.querySelector('dl')).toBeNull();
  });

  it('keeps grouped alerts compact (no outcome, no legacy notice, no badge)', () => {
    const el = render(item({ kind: 'grouped', entry_price: null }));
    expect(el.textContent).toContain('Alerte groupée');
    expect(badge(el)).toBeNull();
    expect(el.querySelector('[data-outcome], [data-legacy], [data-entry-score]')).toBeNull();
  });

  it('renders a hostile symbol as text', () => {
    const el = render(item({ symbol: '<img src=x onerror=alert(1)>' }));
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
  });
});
