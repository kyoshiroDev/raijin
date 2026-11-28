import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AdminEnrollmentConfirmResponse,
  AdminEnrollmentStart,
  AdminRecoveryCodes,
  AdminSecondFactor,
  AdminSecurityStatus,
} from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../../config/api-config';
import { loadContracts } from '../../contracts';

/**
 * Client HTTP de la double authentification admin (`/api/v1/admin/security/*`, docs/ARCHITECTURE.md §14.2).
 * Chaque réponse est validée par les contrats. Un compte non admin reçoit 404 partout.
 */
@Injectable({ providedIn: 'root' })
export class AdminSecurityApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  private url(path: string): string {
    return `${this.base}/admin/security${path}`;
  }

  async status(): Promise<AdminSecurityStatus> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(this.url('/status'))), loadContracts()]);
    return contracts.adminSecurityStatusSchema.parse(body);
  }

  /** Démarre (ou recommence) un enrôlement : secret et QR code montrés une seule fois. */
  async startEnrollment(): Promise<AdminEnrollmentStart> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.post(this.url('/enrollment'), {})), loadContracts()]);
    return contracts.adminEnrollmentStartSchema.parse(body);
  }

  /** Code de l'application **et** mot de passe actuel (400 `AUTH_INVALID_CREDENTIALS` si refusé). */
  async confirmEnrollment(code: string, currentPassword: string): Promise<AdminEnrollmentConfirmResponse> {
    const contracts = await loadContracts();
    const request = contracts.adminEnrollmentConfirmRequestSchema.parse({ code, currentPassword });
    const body = await firstValueFrom(this.http.post(this.url('/enrollment/confirm'), request));
    return contracts.adminEnrollmentConfirmResponseSchema.parse(body);
  }

  async verify(factor: AdminSecondFactor): Promise<AdminSecurityStatus> {
    const contracts = await loadContracts();
    const request = contracts.adminVerifyRequestSchema.parse(factor);
    const body = await firstValueFrom(this.http.post(this.url('/verify'), request));
    return contracts.adminSecurityStatusSchema.parse(body);
  }

  /** Nouveaux codes de secours (les anciens sont invalidés) ; exige un code TOTP frais. */
  async regenerateRecoveryCodes(code: string): Promise<AdminRecoveryCodes> {
    const contracts = await loadContracts();
    const request = contracts.adminRegenerateRecoveryCodesRequestSchema.parse({ code });
    const body = await firstValueFrom(this.http.post(this.url('/recovery-codes'), request));
    return contracts.adminRecoveryCodesSchema.parse(body);
  }

  /** Quitte l'espace admin (204) : la session de l'app reste ouverte. */
  async end(): Promise<void> {
    await firstValueFrom(this.http.post(this.url('/end'), {}));
  }
}
