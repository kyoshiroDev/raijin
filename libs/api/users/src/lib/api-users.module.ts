import { DynamicModule, InjectionToken, Module, ModuleMetadata } from '@nestjs/common';
import { ApiAuthModule } from '@raijin/api-auth';
import { AccountBillingCloser, NoopAccountBillingCloser } from './account-billing-closer';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** Compte (profil, export, suppression). Sans `forRoot` : facturation non branchée (clôture sans effet). */
@Module({
  imports: [ApiAuthModule],
  controllers: [UsersController],
  providers: [UsersService, { provide: AccountBillingCloser, useClass: NoopAccountBillingCloser }],
  exports: [UsersService],
})
export class ApiUsersModule {
  /**
   * `options.billingCloser` : fournisseur (ex. `BillingAccountCloser` d'`api-billing`, son module dans
   * `options.imports`) qui résilie l'abonnement avant la suppression du compte.
   */
  static forRoot(options: { imports?: ModuleMetadata['imports']; billingCloser?: InjectionToken } = {}): DynamicModule {
    return {
      module: ApiUsersModule,
      // Global : `UsersService` (flux de suppression) est réutilisé par l'espace admin sans second module de facturation.
      global: true,
      imports: [ApiAuthModule, ...(options.imports ?? [])],
      controllers: [UsersController],
      providers: [
        UsersService,
        options.billingCloser ? { provide: AccountBillingCloser, useExisting: options.billingCloser } : { provide: AccountBillingCloser, useClass: NoopAccountBillingCloser },
      ],
      exports: [UsersService],
    };
  }
}
