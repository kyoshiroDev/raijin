import { TestBed } from '@angular/core/testing';
import { loginRequestSchema, registerRequestSchema } from '@raijin/shared-contracts';
import { zodForm } from './zod-form';

describe('zodForm', () => {
  it('n’affiche les erreurs qu’après la sortie du champ ou l’envoi', () => {
    TestBed.runInInjectionContext(() => {
      const form = zodForm(loginRequestSchema, { email: '', password: '' });
      expect(form.errors()).toEqual({});
      form.touch('email'); // vide : pas encore de rouge
      expect(form.errors().email).toBeUndefined();
      form.set('email', 'pas-un-email');
      form.touch('email');
      expect(form.errors().email).toBe('Adresse e-mail invalide.');
      expect(form.submit()).toBeNull();
      expect(form.errors().password).toBe('Mot de passe requis.');
    });
  });

  it('renvoie les données normalisées par le schéma', () => {
    const form = zodForm(loginRequestSchema, { email: '  Kenji@Exemple.FR ', password: 'x' });
    expect(form.submit()).toEqual({ email: 'kenji@exemple.fr', password: 'x' });
    expect(form.valid()).toBe(true);
  });

  it('applique les règles des contrats (longueur, CGU)', () => {
    const form = zodForm(registerRequestSchema, { email: 'a@b.fr', password: 'court', acceptTerms: false });
    expect(form.submit()).toBeNull();
    expect(form.errors().password).toBe('Au moins 12 caractères.');
    expect(form.errors().acceptTerms).toBe('Accepte les conditions pour continuer.');
    form.set('password', 'une phrase bien longue');
    form.set('acceptTerms', true);
    expect(form.errors()).toEqual({});
  });

  it('erreur serveur rattachée à un champ, effacée à la saisie ; reset', () => {
    const form = zodForm(loginRequestSchema, { email: 'a@b.fr', password: 'x' });
    form.setServerError('password', 'Refusé.');
    expect(form.errors().password).toBe('Refusé.');
    form.set('password', 'y');
    expect(form.errors().password).toBeUndefined();
    form.submit();
    form.reset();
    expect(form.value()).toEqual({ email: 'a@b.fr', password: 'x' });
  });
});
