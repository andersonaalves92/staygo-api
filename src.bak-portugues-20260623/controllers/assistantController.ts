import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  generateAssistantReply,
  getOrCreateAssistantConfig,
  hasOpenAiConfig,
} from "../lib/aiAssistant";

function clampContextMessages(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 10;
  return Math.max(1, Math.min(Math.round(number), 30));
}

export async function getAssistantSettings(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const config = await getOrCreateAssistantConfig(companyId);

    return res.json({
      ...config,
      openAiApiKey: undefined,
      openAiKeyConfigured: Boolean(config.openAiApiKey),
      openAiConfigured: hasOpenAiConfig(config.openAiApiKey),
    });
  } catch (error) {
    console.error("Erro getAssistantSettings:", error);
    return res.status(500).json({ error: "Erro ao buscar assistente IA" });
  }
}

export async function updateAssistantSettings(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const {
      enabled,
      businessDescription,
      tone,
      instructions,
      handoffKeywords,
      fallbackMessage,
      maxContextMessages,
      responseMode,
      openAiApiKey,
      clearOpenAiApiKey,
    } = req.body || {};

    const config = await prisma.aiAssistantConfig.upsert({
      where: { companyId },
      create: {
        companyId,
        enabled: Boolean(enabled),
        responseMode: responseMode === "suggest" ? "suggest" : "auto",
        ...(openAiApiKey ? { openAiApiKey: String(openAiApiKey).trim() } : {}),
        businessDescription: String(businessDescription || ""),
        tone: String(tone || "profissional, humano e objetivo"),
        instructions: String(instructions || ""),
        handoffKeywords: String(
          handoffKeywords || "preço,valor,contrato,humano,atendente,reclamação,cancelar"
        ),
        fallbackMessage: String(
          fallbackMessage || "Vou chamar uma pessoa da equipe para te ajudar melhor."
        ),
        maxContextMessages: clampContextMessages(maxContextMessages),
      },
      update: {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(responseMode !== undefined ? { responseMode: responseMode === "suggest" ? "suggest" : "auto" } : {}),
        ...(openAiApiKey ? { openAiApiKey: String(openAiApiKey).trim() } : {}),
        ...(clearOpenAiApiKey ? { openAiApiKey: null } : {}),
        ...(businessDescription !== undefined
          ? { businessDescription: String(businessDescription) }
          : {}),
        ...(tone !== undefined ? { tone: String(tone) } : {}),
        ...(instructions !== undefined ? { instructions: String(instructions) } : {}),
        ...(handoffKeywords !== undefined ? { handoffKeywords: String(handoffKeywords) } : {}),
        ...(fallbackMessage !== undefined ? { fallbackMessage: String(fallbackMessage) } : {}),
        ...(maxContextMessages !== undefined
          ? { maxContextMessages: clampContextMessages(maxContextMessages) }
          : {}),
      },
    });

    return res.json({
      ...config,
      openAiApiKey: undefined,
      openAiKeyConfigured: Boolean(config.openAiApiKey),
      openAiConfigured: hasOpenAiConfig(config.openAiApiKey),
    });
  } catch (error) {
    console.error("Erro updateAssistantSettings:", error);
    return res.status(500).json({ error: "Erro ao salvar assistente IA" });
  }
}

export async function testAssistant(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ error: "Mensagem obrigatoria" });
    }

    const result = await generateAssistantReply({ companyId, message });
    return res.json(result);
  } catch (error) {
    console.error("Erro testAssistant:", error);
    return res.status(500).json({ error: "Erro ao testar assistente IA" });
  }
}
