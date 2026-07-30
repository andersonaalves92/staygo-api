-- Trial and manual access controls for platform administration.
ALTER TABLE "Company" ADD COLUMN "trialStartsAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "manualAccessUntil" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "accessBlockedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "accessBlockReason" TEXT;

CREATE INDEX "Company_status_idx" ON "Company"("status");
CREATE INDEX "Company_trialEndsAt_idx" ON "Company"("trialEndsAt");
CREATE INDEX "Company_manualAccessUntil_idx" ON "Company"("manualAccessUntil");
