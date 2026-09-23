-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExternalEventLink" ADD COLUMN     "writeLeaseToken" TEXT,
ADD COLUMN     "writeLeaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BillingCustomer" ADD COLUMN     "operationLeaseToken" TEXT,
ADD COLUMN     "operationLeaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BillingRetentionRecord" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerCustomerId" TEXT NOT NULL,
    "providerSubscriptionIds" TEXT[],
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingRetentionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingRetentionRecord_retainUntil_idx" ON "BillingRetentionRecord"("retainUntil");

