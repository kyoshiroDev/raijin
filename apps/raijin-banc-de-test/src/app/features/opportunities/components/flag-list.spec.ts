import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { FlagList, visibleFlags } from './flag-list';

function render(flags: string[], opts: { max?: number | null; compact?: boolean; emptyText?: string } = {}) {
  const fixture = TestBed.createComponent(FlagList);
  fixture.componentRef.setInput('flags', flags);
  if (opts.max !== undefined) fixture.componentRef.setInput('max', opts.max);
  if (opts.compact !== undefined) fixture.componentRef.setInput('compact', opts.compact);
  if (opts.emptyText !== undefined) fixture.componentRef.setInput('emptyText', opts.emptyText);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('visibleFlags', () => {
  it('keeps everything when there is no cap or the list fits', () => {
    expect(visibleFlags(['a', 'b', 'c'], null)).toEqual({ shown: ['a', 'b', 'c'], hidden: 0 });
    expect(visibleFlags(['a', 'b'], 2)).toEqual({ shown: ['a', 'b'], hidden: 0 });
    expect(visibleFlags([], 2)).toEqual({ shown: [], hidden: 0 });
  });

  it('folds the overflow into a count', () => {
    expect(visibleFlags(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], hidden: 1 });
    expect(visibleFlags(['a', 'b', 'c', 'd', 'e'], 2)).toEqual({ shown: ['a', 'b'], hidden: 3 });
  });

  it('tolerates odd caps', () => {
    expect(visibleFlags(['a', 'b'], 0)).toEqual({ shown: [], hidden: 2 });
    expect(visibleFlags(['a', 'b'], -1)).toEqual({ shown: [], hidden: 2 });
    expect(visibleFlags(['a', 'b', 'c'], 1.7)).toEqual({ shown: ['a'], hidden: 2 });
    expect(visibleFlags(['a', 'b'], Number.NaN)).toEqual({ shown: ['a', 'b'], hidden: 0 });
  });
});

describe('FlagList', () => {
  it('renders every flag by default, wrapping, without « +N »', () => {
    const el = render(['LP non verrouillée', 'Top 10 élevé', 'Jeune paire']);
    const items = el.querySelectorAll('li');
    expect(items.length).toBe(3);
    expect(items[0]!.classList).toContain('wrap-anywhere');
    expect(el.querySelector('ul')?.classList).toContain('flex-wrap');
    expect(el.querySelector('[data-more-flags]')).toBeNull();
  });

  it('shows 2 flags then an accessible « +N » beyond the cap', () => {
    const el = render(['a', 'b', 'c', 'd'], { max: 2 });
    expect(el.querySelectorAll('li:not([data-more-flags])').length).toBe(2);
    const more = el.querySelector('[data-more-flags]');
    expect(more?.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('+2');
    expect(more?.querySelector('.sr-only')?.textContent?.trim()).toBe('2 autres signaux, voir la fiche');
  });

  it('uses the singular for a single hidden flag', () => {
    const el = render(['a', 'b', 'c'], { max: 2 });
    expect(el.querySelector('[data-more-flags] .sr-only')?.textContent?.trim()).toBe('1 autre signal, voir la fiche');
  });

  it('keeps the list on one line in compact mode (shrinking pills), full text in the title', () => {
    const el = render(['Top 10 détient beaucoup trop de supply'], { compact: true });
    expect(el.querySelector('ul')?.classList).not.toContain('flex-wrap');
    const li = el.querySelector('li');
    expect(li?.classList).not.toContain('wrap-anywhere');
    expect(li?.classList).toContain('min-w-0');
    expect(li?.getAttribute('title')).toBe('Top 10 détient beaucoup trop de supply');
    expect(li?.querySelector('.truncate')?.textContent).toBe('Top 10 détient beaucoup trop de supply');
  });

  it('renders hostile flag text as text only', () => {
    const el = render(['<img src=x onerror=alert(1)>'], { compact: true });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('li')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows the empty text when there is no flag', () => {
    expect(render([], { emptyText: 'Aucun point d’attention relevé.' }).textContent?.trim()).toBe('Aucun point d’attention relevé.');
    expect(render([]).querySelector('ul')).toBeNull();
  });
});
