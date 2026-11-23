import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Module racine de l'API du banc : app fine, le métier vit dans `libs/bench/*` (docs/ARCHITECTURE.md §17). */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
