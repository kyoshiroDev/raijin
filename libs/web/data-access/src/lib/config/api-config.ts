import { InjectionToken } from '@angular/core';

/** URL de base de l'API Raijin (`/api/v1`), fournie par l'app selon l'environnement. */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api/v1',
});
