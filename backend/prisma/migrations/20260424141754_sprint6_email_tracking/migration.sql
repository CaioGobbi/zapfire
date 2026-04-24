-- AlterTable
ALTER TABLE "email_tokens" ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "resendEmailId" TEXT;

-- CreateIndex
CREATE INDEX "email_tokens_resendEmailId_idx" ON "email_tokens"("resendEmailId");
