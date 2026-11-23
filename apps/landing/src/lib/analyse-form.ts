import { extractSolanaAddress } from '@raijin/shared-util';
import { decorateAppUrl, readStoredAttribution } from './analytics/attribution';
import { track } from './analytics/track';
import { buildAnalyseUrl } from './app-links';

/** Messages d'erreur du champ (tutoiement, factuels). */
export const ANALYSE_FORM_ERRORS = {
  empty: "Colle l'adresse d'un token Solana ou un lien DexScreener, pump.fun, Solscan ou Birdeye.",
  invalid: "Ce n'est pas une adresse de token Solana valide. Vérifie qu'elle est complète (32 à 44 caractères).",
} as const;

export type AnalyseFormResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Résout la saisie en URL de l'app : adresse extraite (brute ou lien connu), validée en base58 puis encodée, base
 * fixée au build (attribut `action` du formulaire), paramètres d'attribution ajoutés. Aucun mint ne part vers GA4.
 */
export function resolveAnalyseTarget(input: string, action: string, doc: Document): AnalyseFormResult {
  if (input.trim() === '') return { ok: false, error: ANALYSE_FORM_ERRORS.empty };
  const extracted = extractSolanaAddress(input);
  const base = action.replace(/\/analyse\/?$/, '');
  const url = extracted ? buildAnalyseUrl(base, extracted.address) : null;
  if (!url) return { ok: false, error: ANALYSE_FORM_ERRORS.invalid };
  return { ok: true, url: decorateAppUrl(url, readStoredAttribution(doc)) };
}

function showError(input: HTMLInputElement, error: HTMLElement, message: string): void {
  input.setAttribute('aria-invalid', 'true');
  error.textContent = message;
  input.focus();
}

function clearError(input: HTMLInputElement, error: HTMLElement): void {
  input.removeAttribute('aria-invalid');
  error.textContent = '';
}

/** Branche un formulaire `[data-analyse-form]` : validation, bouton Coller, navigation vers l'app. */
export function bindAnalyseForm(form: HTMLFormElement, doc: Document = document): void {
  const input = form.querySelector<HTMLInputElement>('input[name="mint"]');
  const error = form.querySelector<HTMLElement>('[data-error]');
  const paste = form.querySelector<HTMLButtonElement>('[data-paste]');
  if (!input || !error) return;
  const action = form.getAttribute('action') ?? '';

  input.addEventListener('input', () => {
    if (input.hasAttribute('aria-invalid')) clearError(input, error);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const result = resolveAnalyseTarget(input.value, action, doc);
    if (!result.ok) {
      showError(input, error, result.error);
      return;
    }
    clearError(input, error);
    track('analyse_demo_lancee');
    doc.location.assign(result.url);
  });

  // Coller en un tap (Clipboard API) ; refus ou API absente : le champ reçoit le focus pour un collage manuel.
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (paste && clipboard && typeof clipboard.readText === 'function') {
    paste.hidden = false;
    paste.addEventListener('click', async () => {
      try {
        const text = await clipboard.readText();
        input.value = text.trim().slice(0, input.maxLength > 0 ? input.maxLength : 256);
        clearError(input, error);
        if (input.value && !extractSolanaAddress(input.value)) showError(input, error, ANALYSE_FORM_ERRORS.invalid);
        else input.focus();
      } catch {
        input.focus();
      }
    });
  }
}
