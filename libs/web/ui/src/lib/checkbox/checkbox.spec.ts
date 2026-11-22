import { TestBed } from '@angular/core/testing';
import { RjCheckbox } from './checkbox';

describe('RjCheckbox', () => {
  it('case native reliée au libellé, cible de 44 px, modèle à jour', async () => {
    const fixture = TestBed.createComponent(RjCheckbox);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const label = host.querySelector('label') as HTMLLabelElement;
    expect(label.htmlFor).toBe(box.id);
    expect(label.className).toContain('min-h-11');
    box.click();
    expect(fixture.componentInstance.checked()).toBe(true);
  });

  it('erreur annoncée via aria-describedby et aria-invalid', async () => {
    const fixture = TestBed.createComponent(RjCheckbox);
    fixture.componentRef.setInput('error', 'Accepte les conditions pour continuer.');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const box = host.querySelector('input') as HTMLInputElement;
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector(`#${box.getAttribute('aria-describedby')}`)?.textContent).toContain('Accepte les conditions');
  });
});
