import { HttpContextToken } from '@angular/common/http';

/** La requête ne déclenche pas de rafraîchissement de session sur 401 (appels d'auth eux-mêmes). */
export const SKIP_SESSION_REFRESH = new HttpContextToken<boolean>(() => false);

/** La requête n'attend pas de jeton CSRF (récupération du jeton lui-même). */
export const SKIP_CSRF = new HttpContextToken<boolean>(() => false);
