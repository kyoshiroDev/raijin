import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RjSwitch } from './switch';

@Component({
  imports: [RjSwitch],
  template: `<rj-switch label="Alertes par e-mail" description="Un e-mail groupé." [checked]="on()" [disabled]="off()" (checkedChange)="changes.push($event); on.set($event)" />`,
})
class Host {
  readonly on = signal(false);
  readonly off = signal(false);
  readonly changes: boolean[] = [];
}

describe('RjSwitch', () => {
  it('role switch, libellé et description reliés, état écrit en toutes lettres', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector(`label[for="${button.id}"]`)?.textContent).toBe('Alertes par e-mail');
    expect(host.querySelector(`#${button.getAttribute('aria-describedby')}`)?.textContent).toBe('Un e-mail groupé.');
    expect(button.textContent).toContain('Désactivé');
    button.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.changes).toEqual([true]);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.textContent).toContain('Activé');
  });

  it('contrôlé : sans mise à jour du parent, l’état ne change pas ; désactivé : aucun événement', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(fixture.componentInstance.changes).toEqual([]);
  });
});
