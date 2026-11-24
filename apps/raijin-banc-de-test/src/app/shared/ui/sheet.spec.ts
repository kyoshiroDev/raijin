import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from './sheet';

@Component({
  imports: [Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button id="trigger" type="button" (click)="open.set(true)">Ouvrir</button>
    <app-sheet heading="Filtres" [(open)]="open">
      <button id="first" type="button">Premier</button>
      <button id="last" type="button">Dernier</button>
    </app-sheet>
  `,
})
class Host {
  readonly open = signal(false);
}

describe('Sheet', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  const dialog = () => el.querySelector('dialog') as HTMLDialogElement;
  const key = (target: Element, k: string, shiftKey = false) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    await fixture.whenStable();
  });

  async function openFromTrigger() {
    const trigger = el.querySelector<HTMLButtonElement>('#trigger');
    trigger?.focus();
    trigger?.click();
    await fixture.whenStable();
    return trigger;
  }

  it('is an accessible modal dialog labelled by its heading', () => {
    const d = dialog();
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(d.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent?.trim()).toBe('Filtres');
    expect(d.hasAttribute('open')).toBe(false);
  });

  it('opens, moves focus inside, locks page scroll', async () => {
    await openFromTrigger();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.documentElement.classList).toContain('scroll-locked');
  });

  it('never lets the dialog itself scroll (iOS shifts it to reveal the animating panel)', async () => {
    await openFromTrigger();
    const d = dialog();
    d.scrollTop = 120;
    d.scrollLeft = 30;
    d.dispatchEvent(new Event('scroll'));
    expect(d.scrollTop).toBe(0);
    expect(d.scrollLeft).toBe(0);
  });

  it('lets the dialog scroll after the opening animation (iOS keeps a focused field above the keyboard)', async () => {
    const now = Date.now();
    await openFromTrigger();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    try {
      const d = dialog();
      d.scrollTop = 120;
      d.dispatchEvent(new Event('scroll'));
      expect(d.scrollTop).toBe(120);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const trigger = await openFromTrigger();
    key(document.activeElement ?? dialog(), 'Escape');
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.documentElement.classList).not.toContain('scroll-locked');
  });

  it('closes on a backdrop tap but not on a tap inside the panel', async () => {
    const trigger = await openFromTrigger();
    el.querySelector<HTMLButtonElement>('#first')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(true);
    el.querySelector<HTMLElement>('[data-sheet-backdrop]')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes with the « Fermer » button', async () => {
    await openFromTrigger();
    el.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('traps Tab / Shift+Tab inside the panel', async () => {
    await openFromTrigger();
    const close = el.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]');
    const last = el.querySelector<HTMLButtonElement>('#last');
    last?.focus();
    key(last as HTMLElement, 'Tab');
    expect(document.activeElement).toBe(close);
    key(close as HTMLElement, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });
});

@Component({
  imports: [Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet heading="Token" [(open)]="outer">
      <button id="outer-btn" type="button">Paper trade</button>
      <app-sheet heading="Paper trade" [(open)]="inner">
        <button id="inner-first" type="button">A</button>
        <button id="inner-last" type="button">B</button>
      </app-sheet>
    </app-sheet>
  `,
})
class NestedHost {
  readonly outer = signal(true);
  readonly inner = signal(false);
}

describe('Sheet (nested)', () => {
  it('keeps the page scroll locked until the last sheet closes', async () => {
    const fixture = TestBed.createComponent(NestedHost);
    await fixture.whenStable();
    fixture.componentInstance.inner.set(true);
    await fixture.whenStable();
    expect(document.documentElement.classList).toContain('scroll-locked');
    fixture.componentInstance.inner.set(false);
    await fixture.whenStable();
    expect(document.documentElement.classList).toContain('scroll-locked');
    fixture.componentInstance.outer.set(false);
    await fixture.whenStable();
    expect(document.documentElement.classList).not.toContain('scroll-locked');
  });

  it('traps Tab in the inner sheet without the outer sheet moving focus again', async () => {
    const fixture = TestBed.createComponent(NestedHost);
    await fixture.whenStable();
    fixture.componentInstance.inner.set(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const last = el.querySelector<HTMLButtonElement>('#inner-last') as HTMLButtonElement;
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const dialogs = el.querySelectorAll('dialog');
    expect(dialogs[1]!.contains(document.activeElement)).toBe(true);
    fixture.destroy();
  });
});
