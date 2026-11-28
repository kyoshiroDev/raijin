import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RjButton, type RjButtonVariant } from './button';

@Component({
  imports: [RjButton],
  template: `<button type="button" [rjButton]="variant()" [loading]="loading()" [disabled]="disabled()">Analyser</button>
    <a href="/x" rjButton="ghost" [disabled]="disabled()">Lien</a>`,
})
class Host {
  readonly variant = signal<RjButtonVariant>('primary');
  readonly loading = signal(false);
  readonly disabled = signal(false);
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, button: root.querySelector('button') as HTMLButtonElement, link: root.querySelector('a') as HTMLAnchorElement };
}

describe('RjButton', () => {
  it('rend le bouton principal jaune avec halo au survol et cible de 44 px', async () => {
    const { button } = await setup();
    expect(button.className).toContain('bg-thunder');
    expect(button.className).toContain('text-on-thunder');
    expect(button.className).toContain('hover:shadow-glow');
    expect(button.className).toContain('min-h-11');
    expect(button.textContent).toContain('Analyser');
  });

  it('applique les variantes secondaire et fantôme sans jaune', async () => {
    const { fixture, button } = await setup();
    fixture.componentInstance.variant.set('secondary');
    await fixture.whenStable();
    expect(button.className).not.toContain('bg-thunder');
    expect(button.className).toContain('bg-surface-raised');
    fixture.componentInstance.variant.set('ghost');
    await fixture.whenStable();
    expect(button.className).toContain('bg-transparent');
    fixture.componentInstance.variant.set('danger');
    await fixture.whenStable();
    expect(button.className).toContain('text-danger');
    expect(button.className).not.toContain('bg-thunder');
  });

  it('en chargement : désactivé, aria-busy et indicateur', async () => {
    const { fixture, button } = await setup();
    fixture.componentInstance.loading.set(true);
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('rj-icon svg.animate-spin')).not.toBeNull();
  });

  it('désactivé : attribut disabled sur <button>, aria-disabled et tabindex -1 sur <a>', async () => {
    const { fixture, button, link } = await setup();
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    expect(button.className).not.toContain('bg-thunder');
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('tabindex')).toBe('-1');
    expect(link.hasAttribute('disabled')).toBe(false);
  });
});
