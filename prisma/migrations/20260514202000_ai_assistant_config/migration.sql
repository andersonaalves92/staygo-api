-- Per-company AI assistant configuration.
CREATE TABLE "AiAssistantConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "businessDescription" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'profissional, humano e objetivo',
    "instructions" TEXT NOT NULL DEFAULT '',
    "handoffKeywords" TEXT NOT NULL DEFAULT 'preço,valor,contrato,humano,atendente,reclamação,cancelar',
    "fallbackMessage" TEXT NOT NULL DEFAULT 'Vou chamar uma pessoa da equipe para te ajudar melhor.',
    "maxContextMessages" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistantConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiAssistantConfig_companyId_key" ON "AiAssistantConfig"("companyId");

ALTER TABLE "AiAssistantConfig" ADD CONSTRAINT "AiAssistantConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
