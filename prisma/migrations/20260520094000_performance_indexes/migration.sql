CREATE INDEX IF NOT EXISTS "Lead_companyId_stage_createdAt_idx" ON "Lead"("companyId", "stage", "createdAt");
CREATE INDEX IF NOT EXISTS "Lead_companyId_createdAt_idx" ON "Lead"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "Conversation_companyId_lastMessageAt_idx" ON "Conversation"("companyId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "Conversation_companyId_stageId_lastMessageAt_idx" ON "Conversation"("companyId", "stageId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "Message_companyId_createdAt_idx" ON "Message"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "Message_companyId_providerMessageId_idx" ON "Message"("companyId", "providerMessageId");
