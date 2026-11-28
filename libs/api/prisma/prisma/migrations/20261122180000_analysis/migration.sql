-- Phase 3 : analyse de token (docs/ARCHITECTURE.md §9.5) et mineur (e) de l'audit de la phase 2.

-- Le verrouillage après échecs de connexion vit dans Redis (compteur par HMAC de l'e-mail) :
-- colonnes réservées jamais utilisées.
ALTER TABLE "User" DROP COLUMN "failedLoginCount",
DROP COLUMN "lockedUntil";

-- TokenAnalysis : version du moteur, faits rejouables par le banc, métadonnées du token
-- (non fiables, nettoyées, sans image), résultat partiel, explication, durée.
ALTER TABLE "TokenAnalysis" ADD COLUMN     "degraded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "engineVersion" TEXT NOT NULL DEFAULT '0.0.0',
ADD COLUMN     "explanation" TEXT,
ADD COLUMN     "facts" JSONB,
ADD COLUMN     "token" JSONB;
