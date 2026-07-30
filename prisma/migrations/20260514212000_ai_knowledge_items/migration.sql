-- Knowledge base used by the AI assistant.
CREATE TABLE "KnowledgeItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'geral',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeItem_companyId_category_idx" ON "KnowledgeItem"("companyId", "category");
CREATE INDEX "KnowledgeItem_companyId_active_idx" ON "KnowledgeItem"("companyId", "active");

ALTER TABLE "KnowledgeItem" ADD CONSTRAINT "KnowledgeItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
