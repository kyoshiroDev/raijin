import { Injectable } from '@nestjs/common';

/**
 * Port de clôture de la facturation avant la suppression d'un compte (audit phase 6, I1) : résilie
 * l'abonnement chez le prestataire de paiement. Relié par `apps/api` au service d'`api-billing`
 * (`ApiUsersModule.forRoot({ billingCloser })`), sans dépendance directe users → billing. Doit lever si le
 * prestataire échoue : le compte est alors conservé.
 */
export abstract class AccountBillingCloser {
  abstract closeForUser(userId: string): Promise<void>;
}

/** Facturation non branchée : rien à clôturer. */
@Injectable()
export class NoopAccountBillingCloser extends AccountBillingCloser {
  async closeForUser(): Promise<void> {
    return undefined;
  }
}
