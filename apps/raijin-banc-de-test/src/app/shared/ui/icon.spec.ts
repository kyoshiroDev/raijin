import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, ICON_PATHS, Icon, type IconName } from './icon';

function render(name: IconName, label?: string) {
  const fixture = TestBed.createComponent(Icon);
  fixture.componentRef.setInput('name', name);
  if (label !== undefined) fixture.componentRef.setInput('label', label);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Icon', () => {
  it('exposes the full set used by the app (nav, actions, states)', () => {
    expect(ICON_NAMES).toEqual(
      expect.arrayContaining([
        'bolt', 'bell', 'wallet', 'chart', 'settings', 'refresh', 'filter', 'copy', 'check', 'warning', 'info',
        'chevron-right', 'chevron-left', 'close', 'external', 'trend-up', 'share', 'eye', 'eye-off', 'arrow-up', 'arrow-down', 'clock',
      ]),
    );
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name].length).toBeGreaterThan(0);
      for (const d of ICON_PATHS[name]) expect(d).toMatch(/^[Mm][\d.\s,-]/);
    }
  });

  it('renders every icon in the house style: 24 viewBox, currentColor stroke 2, round caps and joins, no fill', () => {
    for (const name of ICON_NAMES) {
      const el = render(name);
      const svg = el.querySelector('svg');
      expect(el.getAttribute('data-icon')).toBe(name);
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(Number(svg?.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(1.75);
      expect(Number(svg?.getAttribute('stroke-width'))).toBeLessThanOrEqual(2);
      expect(svg?.getAttribute('stroke-linecap')).toBe('round');
      expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
      expect(svg?.getAttribute('fill')).toBe('none');
      expect(Array.from(svg?.querySelectorAll('path') ?? []).map((p) => p.getAttribute('d'))).toEqual([...ICON_PATHS[name]]);
    }
  });

  it('is decorative by default (aria-hidden, no role, not focusable)', () => {
    const svg = render('bell').querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.getAttribute('aria-label')).toBeNull();
    expect(svg?.getAttribute('focusable')).toBe('false');
  });

  it('becomes a labelled image when it stands alone', () => {
    const svg = render('warning', 'Attention').querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Attention');
    expect(svg?.getAttribute('aria-hidden')).toBeNull();
  });

  it('switches its paths when the name changes', () => {
    const fixture = TestBed.createComponent(Icon);
    fixture.componentRef.setInput('name', 'eye');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('path')).toHaveLength(ICON_PATHS.eye.length);
    fixture.componentRef.setInput('name', 'eye-off');
    fixture.detectChanges();
    expect(el.querySelectorAll('path')).toHaveLength(ICON_PATHS['eye-off'].length);
    expect(el.getAttribute('data-icon')).toBe('eye-off');
  });
});
