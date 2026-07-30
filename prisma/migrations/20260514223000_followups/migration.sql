-- Follow-up scheduling for commercial workflow.
ALTER TABLE "Conversation" ADD COLUMN "followUpAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "followUpText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Conversation" ADD COLUMN "followUpSentAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "followUpStatus" TEXT NOT NULL DEFAULT 'none';

CREATE INDEX "Conversation_companyId_followUpAt_idx" ON "Conversation"("companyId", "followUpAt");
