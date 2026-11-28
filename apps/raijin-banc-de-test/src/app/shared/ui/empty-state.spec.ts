import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Brand } from './brand';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  function render(title: string, hint?: string) {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('title', title);
    if (hint !== undefined) fixture.componentRef.setInput('hint', hint);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows a decorative dormant lightning, a title and a hint', () => {
    const el = render('Aucune alerte', 'Reviens plus tard.');
    const bolt = el.querySelector('app-bolt-mark');
    expect(bolt?.getAttribute('aria-hidden')).toBe('true');
    expect(bolt?.getAttribute('data-tone')).toBe('dormant');
    expect(bolt?.querySelector('[class*="accent"]')).toBeNull(); // no accent in an empty state
    expect(el.querySelector('[data-empty-title]')?.textContent?.trim()).toBe('Aucune alerte');
    expect(el.querySelector('[data-empty-hint]')?.textContent?.trim()).toBe('Reviens plus tard.');
  });

  it('omits the hint when empty, so the text content is the title only', () => {
    const el = render('Rien ici');
    expect(el.querySelector('[data-empty-hint]')).toBeNull();
    expect(el.textContent?.trim()).toBe('Rien ici');
  });

  it('renders hostile-looking text as text (interpolation only)', () => {
    const el = render('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('Brand', () => {
  it('reads RAIJIN with the accent on JIN and a decorative accent bolt', () => {
    const fixture = TestBed.createComponent(Brand);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim()).toBe('RAIJIN');
    expect(el.querySelector('span.text-accent')?.textContent).toBe('JIN');
    expect(el.querySelector('app-bolt-mark')?.getAttribute('data-tone')).toBe('brand');
    expect(el.querySelector('app-bolt-mark')?.getAttribute('aria-hidden')).toBe('true');
  });
});
