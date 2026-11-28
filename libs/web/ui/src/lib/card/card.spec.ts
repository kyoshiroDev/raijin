import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RjCard } from './card';

@Component({
  imports: [RjCard],
  template: `<rj-card><p>Corps</p><div rjCardFooter>Pied</div></rj-card><rj-card tone="raised">Seul</rj-card>`,
})
class Host {}

describe('RjCard', () => {
  it('prend toute la hauteur, colonne flex et pied poussé en bas', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const [card, raised] = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('rj-card'));
    expect(card?.className).toContain('h-full');
    expect(card?.className).toContain('flex-col');
    expect(card?.className).toContain('rounded-lg');
    const footer = card?.querySelector('[rjCardFooter]')?.parentElement;
    expect(footer?.className).toContain('mt-auto');
    expect(raised?.className).toContain('bg-surface-raised');
  });
});
