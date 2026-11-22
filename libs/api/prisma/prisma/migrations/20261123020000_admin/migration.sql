-- Phase 6 bis (T1a) : migration unique de l'espace admin (docs/ARCHITECTURE.md §14.4) : session admin, codes de secours
-- de la 2FA, suspension et Pro offert, origine des entrées d'audit et index, alertes admin, index des agrégats.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorKind" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "adminLastSeenAt" TIMESTAMP(3),
ADD COLUMN     "adminVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "proGrantEndedAt" TIMESTAMP(3),
ADD COLUMN     "proGrantedUntil" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdminRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAlert" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key" ON "AdminRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminRecoveryCode_userId_idx" ON "AdminRecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminAlert_dedupeKey_key" ON "AdminAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "AdminAlert_resolvedAt_createdAt_idx" ON "AdminAlert"("resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "DailyMetric_key_date_idx" ON "DailyMetric"("key", "date");

-- CreateIndex
CREATE INDEX "User_suspendedAt_idx" ON "User"("suspendedAt");

-- CreateIndex
CREATE INDEX "User_proGrantedUntil_idx" ON "User"("proGrantedUntil");

-- AddForeignKey
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
