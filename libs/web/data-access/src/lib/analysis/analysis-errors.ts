import { ANALYSIS_ERROR_MESSAGES } from '@raijin/shared-contracts';
import { toClientError, type ClientError } from '../http/api-error';

/**
 * Erreur d'analyse : les messages propres à l'analyse remplacent les messages génériques.
 * Module chargé à la demande par `AnalysisStore` (il importe les schémas Zod des contrats).
 */
export function toAnalysisError(error: unknown): ClientError {
  const client = toClientError(error);
  const messages: Readonly<Record<string, string>> = ANALYSIS_ERROR_MESSAGES;
  const message = messages[client.code];
  return message ? { ...client, message } : client;
}
