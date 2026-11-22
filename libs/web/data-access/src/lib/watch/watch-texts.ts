import type { PlanLimits } from '@raijin/shared-contracts';

/** Nom du plan affiché (l'essai Pro est nommé comme tel). */
export function planName(limits: PlanLimits): string {
  if (limits.trialActive) return 'essai Pro';
  return limits.plan === 'PRO' ? 'plan Pro' : 'plan Gratuit';
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

/**
 * Explication de la limite de suivis (bottom sheet « Limite atteinte », écran Suivis) : factuelle,
 * sans urgence ni promesse. `null` = limites inconnues (liste pas encore chargée).
 */
export function watchLimitExplanation(limits: PlanLimits | null): string {
  if (!limits) return 'Tu suis déjà le nombre maximal de tokens pour ton plan. Mets en pause ou retire un suivi pour en ajouter un autre.';
  const base = `Ton ${planName(limits)} permet ${plural(limits.maxActiveWatches, 'suivi')} actif${limits.maxActiveWatches > 1 ? 's' : ''} à la fois. Mets en pause ou retire un suivi pour en ajouter un autre.`;
  return limits.plan === 'FREE' && !limits.trialActive ? `${base} Le plan Pro permet d’en suivre davantage.` : base;
}
