// Îlot du champ d'analyse (script module externe, aucun script inline : CSP `script-src 'self'`).
import { bindAnalyseForm } from '../lib/analyse-form';

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-analyse-form]')) bindAnalyseForm(form);
