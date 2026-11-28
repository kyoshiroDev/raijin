import { Injectable } from '@nestjs/common';

/** Horloge de l'espace admin (remplacée dans les tests). */
@Injectable()
export class AdminClock {
  now(): Date {
    return new Date();
  }
}
