import { TestBed } from '@angular/core/testing';
import { RjSkeleton } from '../skeleton/skeleton';
import { RjEmptyState } from './empty-state';
import { RjErrorState } from './error-state';

describe('États', () => {
  it('EmptyState : Rai bravo, titre et message', async () => {
    const fixture = TestBed.createComponent(RjEmptyState);
    fixture.componentRef.setInput('title', 'Aucun token suivi');
    fixture.componentRef.setInput('description', 'Analyse un token puis touche « Suivre ».');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('img')?.getAttribute('src')).toBe('brand/mascot/rai-bravo.svg');
    expect(host.querySelector('h2')?.textContent).toBe('Aucun token suivi');
  });

  it('ErrorState : Rai alerte, rôle alert et bouton « Réessayer » qui émet retry', async () => {
    const fixture = TestBed.createComponent(RjErrorState);
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('alert');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('brand/mascot/rai-alerte.svg');
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Réessayer');
    expect(button.className).not.toContain('bg-thunder');
    button.click();
    expect(retry).toHaveBeenCalled();
  });

  it('Skeleton : décoratif et animé', async () => {
    const fixture = TestBed.createComponent(RjSkeleton);
    fixture.componentRef.setInput('shape', 'circle');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.className).toContain('animate-pulse');
    expect(host.className).toContain('rounded-full');
  });
});
