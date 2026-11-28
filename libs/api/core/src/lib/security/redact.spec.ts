import { redactCredentials } from './redact';

describe('redactCredentials', () => {
  it('masque mot de passe et utilisateur des URL de connexion, garde l’hôte', () => {
    expect(redactCredentials('Error: connect ECONNREFUSED redis://:0a1b2c3d@raijin-redis:6379')).toBe('Error: connect ECONNREFUSED redis://***@raijin-redis:6379');
    expect(redactCredentials('postgresql://raijin:motdepasse@db:5432/raijin et rediss://u:p@h:1')).toBe('postgresql://***@db:5432/raijin et rediss://***@h:1');
    expect(redactCredentials('aucune URL ici, ni http://exemple.fr/chemin')).toBe('aucune URL ici, ni http://exemple.fr/chemin');
  });
});
