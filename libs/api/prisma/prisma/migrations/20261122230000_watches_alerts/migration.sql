-- Phase 4 : suivis, alertes et push (docs/ARCHITECTURE.md §11.5, §11.6, §11.9).
-- Suivis en pause, état par mint, événements idempotents (mint + dedupeKey), une alerte par
-- utilisateur et événement, préférences de notification, journal des jobs, index des purges.
-- CreateEnum
CREATE TYPE "WatchStatus" AS ENUM ('active', 'paused');

-- CreateEnum
CREATE TYPE "WatchPauseReason" AS ENUM ('user', 'plan_limit');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('warn', 'danger');

-- DropIndex
DROP INDEX "PushSubscription_userId_idx";

-- DropIndex
DROP INDEX "Watch_mint_idx";

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "emailSkipped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "eventId" UUID,
ADD COLUMN     "pushedAt" TIMESTAMP(3),
ADD COLUMN     "severity" "AlertSeverity" NOT NULL DEFAULT 'warn',
ADD COLUMN     "token" JSONB;

-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "details" JSONB,
ADD COLUMN     "durationMs" INTEGER;

-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN     "lastSuccessAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyEmailAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyPushAlerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyWeeklyDigest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "weeklyDigestSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Watch" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" "WatchPauseReason",
ADD COLUMN     "status" "WatchStatus" NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "MintWatchState" (
    "mint" TEXT NOT NULL,
    "snapshot" JSONB,
    "token" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "nextFastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextHoldersAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextFullAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEarlyFullAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "unanalyzable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MintWatchState_pkey" PRIMARY KEY ("mint")
);

-- CreateTable
CREATE TABLE "WatchEvent" (
    "id" UUID NOT NULL,
    "mint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MintWatchState_nextFastAt_idx" ON "MintWatchState"("nextFastAt");

-- CreateIndex
CREATE INDEX "MintWatchState_nextHoldersAt_idx" ON "MintWatchState"("nextHoldersAt");

-- CreateIndex
CREATE INDEX "MintWatchState_nextFullAt_idx" ON "MintWatchState"("nextFullAt");

-- CreateIndex
CREATE INDEX "WatchEvent_mint_type_detectedAt_idx" ON "WatchEvent"("mint", "type", "detectedAt");

-- CreateIndex
CREATE INDEX "WatchEvent_createdAt_idx" ON "WatchEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WatchEvent_mint_dedupeKey_key" ON "WatchEvent"("mint", "dedupeKey");

-- CreateIndex
CREATE INDEX "Alert_userId_readAt_idx" ON "Alert"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_userId_eventId_key" ON "Alert"("userId", "eventId");

-- CreateIndex
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

-- CreateIndex
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_createdAt_idx" ON "PushSubscription"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TrialFingerprint_createdAt_idx" ON "TrialFingerprint"("createdAt");

-- CreateIndex
CREATE INDEX "Watch_mint_status_idx" ON "Watch"("mint", "status");

-- CreateIndex
CREATE INDEX "Watch_userId_status_idx" ON "Watch"("userId", "status");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WatchEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

