import {
  ALERT_TYPE_LABELS,
  VERDICT_LABELS,
  type AlertEvent,
  type AlertSeverity,
  type TokenMetadata,
} from '@raijin/shared-contracts';
import { truncateMiddle } from '@raijin/shared-util';

/**
 * Alerte telle que rendue dans un e-mail ou une notification push. Les métadonnées du token sont
 * déjà nettoyées par `tokenMetadataSchema` (nom et symbole choisis par le créateur : non fiables).
 */
export type AlertMessage = AlertEvent & {
  readonly id: string;
  readonly mint: string;
  readonly severity: AlertSeverity;
  readonly token: TokenMetadata | null;
  readonly createdAt: Date;
};

const pct = (value: number): string => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value)} %`;

/** Libellé de gravité (jamais la couleur seule) : « Danger » ou « Prudence ». */
export function severityLabel(severity: AlertSeverity): string {
  return severity === 'danger' ? VERDICT_LABELS.danger : VERDICT_LABELS.warn;
}

/** « BONK · DezX…B263 » : symbole (ou nom) non vérifié + mint tronqué. */
export function tokenLabel(mint: string, token: TokenMetadata | null): string {
  const name = token?.symbol || token?.name || 'Token';
  return `${name} · ${truncateMiddle(mint, 4, 4)}`;
}

/** Phrase simple décrivant l'événement (texte rédigé par Raijin, chiffres seulement). */
export function describeAlert(event: AlertEvent): string {
  switch (event.type) {
    case 'verdict_degraded':
      return `Le verdict passe de ${VERDICT_LABELS[event.payload.from]} à ${VERDICT_LABELS[event.payload.to]}.`;
    case 'lp_removed':
      return `Liquidité du pool principal retirée de ${pct(event.payload.dropPct)} depuis son plus haut récent.`;
    case 'mint_reactivated':
      return 'L’autorité de mint est de nouveau active : de nouveaux tokens peuvent être créés.';
    case 'freeze_reactivated':
      return 'L’autorité de freeze est de nouveau active : des comptes peuvent être gelés.';
    case 'holder_sold': {
      const { beforePct, afterPct, soldPctOfPosition } = event.payload;
      const after = afterPct === null ? 'sorti du top 20' : `${pct(afterPct)} de l’offre`;
      return `Un holder à ${pct(beforePct)} de l’offre a cédé ${pct(soldPctOfPosition)} de sa position (vente ou transfert, ${after}).`;
    }
  }
}

/** Titre court : « Liquidité retirée ». */
export function alertTitle(event: AlertEvent): string {
  return ALERT_TYPE_LABELS[event.type];
}
