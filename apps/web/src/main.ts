import { bootstrapApplication } from '@angular/platform-browser';
import { startWhenInteractive } from '@raijin/web-data-access';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Sur /t/<mint> avec verdict statique injecté : démarrage à la première interaction (docs/ARCHITECTURE.md §10.7).
startWhenInteractive(() => bootstrapApplication(App, appConfig).catch((err) => console.error(err)));
