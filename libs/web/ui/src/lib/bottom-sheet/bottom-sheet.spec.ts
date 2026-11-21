import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RjBottomSheet } from './bottom-sheet';

@Component({
  imports: [RjBottomSheet],
  template: `
    <button id="trigger" type="button" (click)="open.set(true)">Ouvrir</button>
    <rj-bottom-sheet title="Ajouter aux suivis" description="Raijin te prévient." [(open)]="open">
      <button id="first" type="button">Premier</button>
      <button id="last" type="button">Dernier</button>
    </rj-bottom-sheet>
  `,
})
class Host {
  readonly open = signal(false);
}

async function openSheet() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const trigger = root.querySelector('#trigger') as HTMLButtonElement;
  trigger.focus();
  trigger.click();
  await fixture.whenStable();
  return { fixture, root, trigger };
}

describe('RjBottomSheet', () => {
  it('est fermé par défaut', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).toBeNull();
  });

  it('s’ouvre en dialogue modal étiqueté et place le focus dans le contenu', async () => {
    const { root } = await openSheet();
    const dialog = root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog.getAttribute('aria-labelledby') ?? '';
    expect(root.querySelector(`#${titleId}`)?.textContent).toBe('Ajouter aux suivis');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement?.id).toBe('first');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('piège le focus avec Tab et Maj+Tab', async () => {
    const { root } = await openSheet();
    const dialog = root.querySelector('[role="dialog"]') as HTMLElement;
    const last = root.querySelector('#last') as HTMLButtonElement;
    last.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Fermer');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement?.id).toBe('last');
  });

  it('se ferme avec Échap et rend le focus au déclencheur', async () => {
    const { fixture, root, trigger } = await openSheet();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('');
    root.remove();
  });

  it('se ferme avec le bouton Fermer', async () => {
    const { fixture, root } = await openSheet();
    (root.querySelector('button[aria-label="Fermer"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    root.remove();
  });
});
