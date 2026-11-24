import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyAddress } from './copy-address';

const VALID = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('CopyAddress', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  function create(address: string) {
    const fixture = TestBed.createComponent(CopyAddress);
    fixture.componentRef.setInput('address', address);
    fixture.componentRef.setInput('label', 'TEST');
    fixture.detectChanges();
    return fixture;
  }

  it('copies a valid address and shows the head/tail check', async () => {
    const fixture = create(VALID);
    await fixture.componentInstance.copy();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith(VALID);
    expect(fixture.nativeElement.textContent).toContain('EPjF');
    expect(fixture.nativeElement.textContent).toContain('Dt1v');
  });

  it('never copies an invalid address', async () => {
    const fixture = create('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtlv');
    await fixture.componentInstance.copy();
    fixture.detectChanges();
    expect(writeText).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(true);
  });

  it('accessible name starts with the visible text (WCAG 2.5.3)', async () => {
    const fixture = create(VALID);
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    const visible = () => (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(button.getAttribute('aria-label')!.startsWith(visible())).toBe(true);
    expect(button.getAttribute('aria-label')).toContain('TEST');
    await fixture.componentInstance.copy();
    fixture.detectChanges();
    expect(visible()).toContain('Copié');
    expect(button.getAttribute('aria-label')!.startsWith(visible())).toBe(true);
  });
});
