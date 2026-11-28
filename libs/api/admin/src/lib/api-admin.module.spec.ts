import { ApiAdminModule } from './api-admin.module';

describe('ApiAdminModule', () => {
  it('est exporté par la lib (test minimal, complété par les services de l’espace admin)', () => {
    expect(typeof ApiAdminModule).toBe('function');
  });
});
