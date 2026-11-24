import { analysisResponseSchema, analysisResultSchema } from '@raijin/shared-contracts';
import type { AnalysisValidationReply, AnalysisValidationRequest } from './analysis-validation';

/**
 * Validation complète d'une analyse par les contrats Zod, **hors du fil principal** (docs/ARCHITECTURE.md §10.6) :
 * l'évaluation de Zod et des schémas ne bloque plus l'écran après l'affichage du verdict (TBT). Le résultat
 * nettoyé revient par clonage structuré ; un rejet est rejoué sur le fil principal pour garder l'erreur exacte.
 */
const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<AnalysisValidationRequest>) => void): void;
  postMessage(message: AnalysisValidationReply): void;
};

scope.addEventListener('message', ({ data }) => {
  const schema = data.kind === 'response' ? analysisResponseSchema : analysisResultSchema;
  const parsed = schema.safeParse(data.body);
  scope.postMessage(parsed.success ? { id: data.id, ok: true, data: parsed.data } : { id: data.id, ok: false });
});
