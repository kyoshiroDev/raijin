import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminGuard, AuthGuard } from '@raijin/api-auth';
import { AdminReportsController } from './admin-reports.controller';

describe('AdminReportsController', () => {
  it('chaque route admin/* est derrière AuthGuard puis AdminGuard (aucune route oubliée)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminReportsController)).toBe('admin');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminReportsController)).toEqual([AuthGuard, AdminGuard]);
    const proto = AdminReportsController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined);
    expect(routes.map((name) => Reflect.getMetadata(PATH_METADATA, proto[name] as object)).sort()).toEqual(
      ['acquisition', 'health', 'overview', 'product', 'revenue', 'seo', 'traffic', 'trials'],
    );
    // Aucune route de cette lib ne redéfinit ses propres gardes (rien ne contourne AdminGuard).
    for (const name of routes) expect(Reflect.getMetadata(GUARDS_METADATA, proto[name] as object)).toBeUndefined();
  });

  it('aucune mutation : lecture seule (pas de POST, PUT, PATCH, DELETE)', () => {
    const proto = AdminReportsController.prototype as unknown as Record<string, object>;
    const methods = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('method', proto[name] as object));
    expect(methods.every((method) => method === 0)).toBe(true); // RequestMethod.GET
  });
});
