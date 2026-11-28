// Îlot de l'analyse de démonstration : résultat atténué puis révélé au clic (visible sans JS).
import { bindDemo } from '../lib/demo/demo-island';

for (const root of document.querySelectorAll<HTMLElement>('[data-demo]')) bindDemo(root);
