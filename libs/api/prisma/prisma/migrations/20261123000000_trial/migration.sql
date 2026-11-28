-- Phase 6 (T1) : essai Pro 7 jours, anti-abus durable par e-mail, préférences et idempotence des e-mails d'essai.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyTrialEmails" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "trialDay1MailAt" TIMESTAMP(3),
ADD COLUMN     "trialDayMinus2MailAt" TIMESTAMP(3),
ADD COLUMN     "trialEndMailAt" TIMESTAMP(3),
ADD COLUMN     "trialEndScreenSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrialClaim" (
    "id" UUID NOT NULL,
    "emailHash" TEXT NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrialClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrialClaim_emailHash_key" ON "TrialClaim"("emailHash");

-- CreateIndex
CREATE INDEX "TrialClaim_userId_idx" ON "TrialClaim"("userId");

-- CreateIndex
CREATE INDEX "TrialClaim_createdAt_idx" ON "TrialClaim"("createdAt");

-- CreateIndex
CREATE INDEX "User_trialStatus_trialEndsAt_idx" ON "User"("trialStatus", "trialEndsAt");

-- AddForeignKey
ALTER TABLE "TrialClaim" ADD CONSTRAINT "TrialClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
