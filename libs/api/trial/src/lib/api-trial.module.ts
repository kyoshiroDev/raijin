import { Module } from '@nestjs/common';
import { ApiAlertsModule } from '@raijin/api-alerts';
import { ApiAnalysisModule } from '@raijin/api-analysis';
import { ApiAuthModule } from '@raijin/api-auth';
import { ApiNotificationsModule } from '@raijin/api-notifications';
import { TrialAdminController, TrialController, TrialInternalController } from './trial.controller';
import { TrialConversionService } from './trial-conversion.service';
import { TrialLifecycleService } from './trial-lifecycle.service';
import { TrialRecapService } from './trial-recap.service';

/**
 * Essai Pro (PROMPT.md §4.4, docs/ARCHITECTURE.md §13) : job horaire de fin d'essai et e-mails J+1 / J-2 / J0,
 * `GET trial/recap`, `POST trial/end-screen/seen`, `GET admin/trial-conversion`, horloge simulée des tests.
 * Le démarrage de l'essai vit dans `api-auth` (vérification de l'e-mail). Requiert `ApiCoreModule` et
 * `ApiPrismaModule` (globaux). `TrialLifecycleService.endTrialOnSubscriptionInTx` est exporté pour `api-billing`.
 */
@Module({
  imports: [ApiAuthModule, ApiAnalysisModule, ApiAlertsModule, ApiNotificationsModule],
  controllers: [TrialController, TrialAdminController, TrialInternalController],
  providers: [TrialLifecycleService, TrialRecapService, TrialConversionService],
  exports: [TrialLifecycleService, TrialRecapService],
})
export class ApiTrialModule {}
