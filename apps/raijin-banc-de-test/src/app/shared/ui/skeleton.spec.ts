import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Skeleton, type SkeletonVariant } from './skeleton';

function render(variant: SkeletonVariant, count?: number, label?: string) {
  const fixture = TestBed.createComponent(Skeleton);
  fixture.componentRef.setInput('variant', variant);
  if (count !== undefined) fixture.componentRef.setInput('count', count);
  if (label !== undefined) fixture.componentRef.setInput('label', label);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Skeleton', () => {
  it('is one busy live region with a screen-reader label only (no visible loading text)', () => {
    const el = render('token-card', 3, 'Recherche des opportunités…');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('data-skeleton')).toBe('token-card');
    expect(el.querySelector('.sr-only')?.textContent?.trim()).toBe('Recherche des opportunités…');
    const visual = el.querySelector('[aria-hidden="true"]');
    expect(visual?.textContent?.trim()).toBe('');
    expect(el.querySelectorAll('[data-skeleton-item]')).toHaveLength(3);
    expect(el.querySelectorAll('.skeleton').length).toBeGreaterThan(3);
  });

  it('uses the same responsive grid as the real cards for card variants, a stack otherwise', () => {
    expect(render('token-card').querySelector('[aria-hidden="true"]')?.classList).toContain('md:grid-cols-2');
    expect(render('candidate-card').querySelector('[aria-hidden="true"]')?.classList).toContain('lg:grid-cols-3');
    expect(render('wallet').querySelector('[aria-hidden="true"]')?.classList).toContain('space-y-3');
  });

  it('renders each variant and clamps the count to 1–12', () => {
    for (const v of ['token-card', 'candidate-card', 'wallet', 'rows', 'detail'] as const) {
      expect(render(v).querySelectorAll('[data-skeleton-item]')).toHaveLength(1);
    }
    expect(render('rows', 0).querySelectorAll('[data-skeleton-item]')).toHaveLength(1);
    expect(render('rows', 99).querySelectorAll('[data-skeleton-item]')).toHaveLength(12);
    expect(render('rows', Number.NaN).querySelectorAll('[data-skeleton-item]')).toHaveLength(1);
  });

  it('has a default screen-reader label', () => {
    expect(render('rows').querySelector('.sr-only')?.textContent?.trim()).toBe('Chargement…');
  });
});
