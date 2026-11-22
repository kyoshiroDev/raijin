import { AUTH_EMAIL_LINK_PATHS } from '@raijin/shared-contracts';
import { webFeatureCompteRoutes } from './lib.routes';

describe('Routes de Compte', () => {
  it('chaque lien envoyé par e-mail (contrat API) a sa route', () => {
    const paths = webFeatureCompteRoutes.map((route) => `/compte/${route.path}`);
    for (const link of Object.values(AUTH_EMAIL_LINK_PATHS)) {
      expect(paths).toContain(link);
    }
  });
});
