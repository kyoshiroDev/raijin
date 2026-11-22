-- Phase 6 (T2) : abonnement Stripe. Ordre des webhooks (horodatage du dernier événement appliqué) et dernière facture.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "latestInvoiceId" TEXT;

-- CreateIndex
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");
