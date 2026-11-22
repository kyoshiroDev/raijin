import { TestBed } from '@angular/core/testing';
import { RjClipboard } from '../clipboard/clipboard';
import { RjInputField } from './input-field';

function setup(read: () => Promise<string | null>) {
  TestBed.configureTestingModule({ providers: [{ provide: RjClipboard, useValue: { read, copy: vi.fn() } }] });
  const fixture = TestBed.createComponent(RjInputField);
  fixture.componentRef.setInput('label', 'Adresse du token');
  fixture.componentRef.setInput('pasteable', true);
  fixture.componentRef.setInput('mono', true);
  return fixture;
}

describe('RjInputField', () => {
  it('relie le libellé au champ, texte 16 px, attributs mobiles', async () => {
    const fixture = setup(async () => null);
    fixture.componentRef.setInput('inputmode', 'text');
    fixture.componentRef.setInput('enterkeyhint', 'search');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input') as HTMLInputElement;
    const label = host.querySelector('label') as HTMLLabelElement;
    expect(label.htmlFor).toBe(input.id);
    expect(input.className).toContain('text-input');
    expect(input.className).toContain('min-h-12');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('colle le contenu du presse-papiers (nettoyé) et émet pasted', async () => {
    const fixture = setup(async () => '  7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU \n');
    const pasted = vi.fn();
    fixture.componentInstance.pasted.subscribe(pasted);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(pasted).toHaveBeenCalledWith('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  });

  it('tronque le texte collé à maxlength (256 par défaut) et pose maxlength sur le champ', async () => {
    const fixture = setup(async () => 'a'.repeat(5000));
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('input')?.getAttribute('maxlength')).toBe('256');
    (host.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toHaveLength(256);
  });

  it('collage refusé : message de repli, focus sur le champ, pasteFailed émis', async () => {
    const fixture = setup(async () => null);
    const failed = vi.fn();
    fixture.componentInstance.pasteFailed.subscribe(failed);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    const input = host.querySelector('input') as HTMLInputElement;
    expect(failed).toHaveBeenCalled();
    expect(document.activeElement === input || host.contains(document.activeElement)).toBe(true);
    const message = host.querySelector('[role="status"]');
    expect(message?.textContent).toContain('Coller');
    expect(input.getAttribute('aria-describedby')).toBe(message?.id);
  });

  it('erreur : aria-invalid et message relié', async () => {
    const fixture = setup(async () => null);
    fixture.componentRef.setInput('error', 'Ce n’est pas une adresse Solana valide.');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const message = host.querySelector(`#${input.getAttribute('aria-describedby')}`);
    expect(message?.textContent).toContain('pas une adresse');
  });

  it('met à jour la valeur à la saisie', async () => {
    const fixture = setup(async () => null);
    await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.value()).toBe('abc');
  });
});

describe('RjInputField : mot de passe', () => {
  it('bouton afficher / masquer, required et événement blurred', async () => {
    const fixture = TestBed.createComponent(RjInputField);
    fixture.componentRef.setInput('label', 'Mot de passe');
    fixture.componentRef.setInput('type', 'password');
    fixture.componentRef.setInput('revealable', true);
    fixture.componentRef.setInput('required', true);
    const blurred = vi.fn();
    fixture.componentInstance.blurred.subscribe(blurred);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.required).toBe(true);
    expect(input.getAttribute('aria-required')).toBe('true');
    const toggle = host.querySelector('button[aria-controls]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-label')).toBe('Afficher le mot de passe');
    expect(toggle.className).toContain('min-h-11');
    toggle.click();
    await fixture.whenStable();
    expect(input.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    input.dispatchEvent(new Event('blur'));
    expect(blurred).toHaveBeenCalled();
  });
});
