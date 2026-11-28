import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import { BillingSimulationService } from '../simulation/billing-simulation.service';

/** Routes de simulation : 404 (comme une route inexistante) hors `BILLING_PROVIDER=fake` et en production, avant toute autre garde. */
@Injectable()
export class SimulationOnlyGuard implements CanActivate {
  constructor(private readonly simulation: BillingSimulationService) {}

  canActivate(): boolean {
    try {
      this.simulation.fake();
      return true;
    } catch {
      throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    }
  }
}
