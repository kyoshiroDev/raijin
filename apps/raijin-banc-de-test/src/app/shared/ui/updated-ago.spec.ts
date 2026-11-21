import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPDATED_AGO_TICK_MS, UpdatedAgo } from './updated-ago';

describe('UpdatedAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('is a polite live region refreshed every 30 s, and clears its timer on destroy', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-11-16T12:00:00Z'));
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const fixture = TestBed.createComponent(UpdatedAgo);
    fixture.componentRef.setInput('at', new Date('2026-11-16T11:58:00Z'));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.textContent?.trim()).toBe('Mis à jour il y a 2 min');

    vi.advanceTimersByTime(UPDATED_AGO_TICK_MS * 2);
    fixture.detectChanges();
    expect(el.textContent?.trim()).toBe('Mis à jour il y a 3 min');

    fixture.destroy();
    expect(clear).toHaveBeenCalled();
  });
});
