import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RjStatusPage } from './status-page';

@Component({
  imports: [RjStatusPage],
  template: `<rj-status-page eyebrow="Erreur 404" title="Cette page n’existe pas" description="Le lien est incomplet."><a href="/analyse">Retour</a></rj-status-page>`,
})
class Host {}

describe('RjStatusPage', () => {
  it('Rai bravo décoratif, repère, titre h1, phrase et action projetée', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toContain('rai-bravo.svg');
    expect(img?.getAttribute('alt')).toBe('');
    expect(host.querySelector('h1')?.textContent).toBe('Cette page n’existe pas');
    expect(host.textContent).toContain('Erreur 404');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/analyse');
  });
});
