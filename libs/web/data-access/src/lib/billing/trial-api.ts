import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { TrialRecap } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/** Client HTTP de l'essai Pro (`/api/v1/trial`) : récapitulatif de fin d'essai et écran vu. */
@Injectable({ providedIn: 'root' })
export class TrialApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** 404 `TRIAL_NOT_FOUND` si le compte n'a jamais eu d'essai. */
  async recap(): Promise<TrialRecap> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/trial/recap`)), loadContracts()]);
    return contracts.trialRecapSchema.parse(body);
  }

  /** L'écran de fin d'essai ne se représente plus (204). */
  async markEndScreenSeen(): Promise<void> {
    await firstValueFrom(this.http.post(`${this.base}/trial/end-screen/seen`, {}));
  }
}
