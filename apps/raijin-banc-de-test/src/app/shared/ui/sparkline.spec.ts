import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Sparkline } from './sparkline';

function render(values: readonly number[] | null) {
  const fixture = TestBed.createComponent(Sparkline);
  fixture.componentRef.setInput('values', values);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Sparkline', () => {
  it('draws an aria-hidden green line + area when the last point is ≥ the first, with the 6 h change as sr-only text', () => {
    const el = render([1, 1.5, 1.2]);
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.classList).toContain('text-bull');
    expect(svg?.getAttribute('data-trend')).toBe('up');
    expect(el.querySelector('[data-spark-line]')?.getAttribute('points')).toBe('0,30 50,2 100,18.8');
    expect(el.querySelector('[data-spark-area]')?.getAttribute('fill-opacity')).toBe('0.12');
    expect(el.querySelector('[data-spark-sr]')?.classList).toContain('sr-only');
    expect(el.querySelector('[data-spark-sr]')?.textContent?.trim()).toBe('Variation 6 h : +20 %');
  });

  it('is red when the last point is below the first', () => {
    const el = render([2, 2.5, 1.5]);
    expect(el.querySelector('svg')?.classList).toContain('text-bear');
    expect(el.querySelector('[data-spark-sr]')?.textContent?.trim()).toBe('Variation 6 h : −25 %');
  });

  it('renders nothing when null or with fewer than 2 points', () => {
    for (const v of [null, [], [1]]) {
      const el = render(v);
      expect(el.querySelector('svg')).toBeNull();
      expect(el.textContent?.trim()).toBe('');
    }
  });
});
