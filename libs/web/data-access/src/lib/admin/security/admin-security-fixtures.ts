import type { AdminEnrollmentStart, AdminRecoveryCodes, AdminSecurityStatus } from '@raijin/shared-contracts';

/** Réponses simulées de `admin/security/*`, conformes aux contrats (tests unitaires, e2e, captures). */

export function fakeAdminSecurityStatus(overrides: Partial<AdminSecurityStatus> = {}): AdminSecurityStatus {
  const now = Date.now();
  return {
    enrolled: true,
    verified: true,
    idleExpiresAt: new Date(now + 30 * 60_000).toISOString(),
    absoluteExpiresAt: new Date(now + 8 * 3_600_000).toISOString(),
    idleTimeoutSeconds: 1800,
    recoveryCodesRemaining: 10,
    ...overrides,
  };
}

/** Admin pas encore enrôlé (2FA à activer). */
export function fakeAdminNotEnrolled(): AdminSecurityStatus {
  return fakeAdminSecurityStatus({
    enrolled: false,
    verified: false,
    idleExpiresAt: null,
    absoluteExpiresAt: null,
    recoveryCodesRemaining: null,
  });
}

/** Admin enrôlé dont la session n'a pas encore saisi de code. */
export function fakeAdminNotVerified(overrides: Partial<AdminSecurityStatus> = {}): AdminSecurityStatus {
  return fakeAdminSecurityStatus({ verified: false, idleExpiresAt: null, absoluteExpiresAt: null, ...overrides });
}

/** QR code factice (SVG valide, motif décoratif) : jamais un vrai secret. */
const FAKE_QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">' +
  '<rect width="29" height="29" fill="#fff"/>' +
  '<path fill="#000" d="M2 2h7v7H2zM20 2h7v7h-7zM2 20h7v7H2zM4 4v3h3V4zM22 4v3h3V4zM4 22v3h3v-3zM11 2h2v2h-2zM14 4h2v3h-2zM11 8h3v2h-3zM16 10h3v2h-3zM11 12h2v3h-2zM2 11h3v2H2zM6 13h3v2H6zM14 14h3v3h-3zM19 14h2v2h-2zM22 11h3v2h-3zM25 15h2v3h-2zM20 18h3v2h-3zM11 18h2v3h-2zM15 20h3v2h-3zM11 23h3v2h-3zM16 24h2v3h-2zM20 22h2v3h-2zM23 24h4v3h-4z"/>' +
  '</svg>';

export function fakeAdminEnrollment(overrides: Partial<AdminEnrollmentStart> = {}): AdminEnrollmentStart {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  return {
    otpauthUri: `otpauth://totp/Raijin:admin@exemple.fr?secret=${secret}&issuer=Raijin`,
    secret,
    qrCodeDataUri: `data:image/svg+xml;base64,${btoa(FAKE_QR_SVG)}`,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

export function fakeAdminRecoveryCodes(): AdminRecoveryCodes {
  return {
    codes: [
      'ABCDE-FGH23',
      'KLMNO-PQR45',
      'STUVW-XYZ67',
      'BCDEF-GHJ23',
      'MNOPQ-RST45',
      'UVWXY-ZAB67',
      'CDEFG-HIJ23',
      'NOPQR-STU45',
      'VWXYZ-ABC67',
      'DEFGH-IJK23',
    ],
    generatedAt: new Date().toISOString(),
  };
}
