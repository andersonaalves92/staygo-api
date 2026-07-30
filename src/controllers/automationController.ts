import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  generateAssistantReply,
  getOrCreateAssistantConfig,
} from "../lib/aiAssistant";
import {
  matchFaqRule,
  normalizePhone,
  resolveCompanyIdFromInstance,
} from "../lib/automation";
import { processDueFollowUps } from "../lib/followups";

async function getCompanyId(req: Request, res: Response) {
  const instanceName = String(req.body.instanceName || req.body.instance || "").trim();
  const companyId = await resolveCompanyIdFromInstance(instanceName);

  if (!companyId) {
    res.status(400).json({ error: "Instancia nao vinculada a empresa" });
    return null;
  }

  return companyId;
}

export async function saveLeadFromAutomation(req: Request, res: Response) {
  try {
    const companyId = await getCompanyId(req, res);
    if (!companyId) return;

    const phone = normalizePhone(req.body.phone);
    const message = String(req.body.message || "");
    const contactName = req.body.contactName ? String(req.body.contactName) : null;
    const providerMessageId = req.body.providerMessageId
      ? String(req.body.providerMessageId)
      : null;

    if (!phone || !message) {
      return res.status(400).json({ error: "phone e message sao obrigatorios" });
    }

    let lead = await prisma.lead.findFirst({ where: { companyId, phone } });

    if (!lead) {
      lead = await prisma.lead.create({
        data: { companyId, phone, message, contactName, stage: "Novo lead" },
      });
    } else {
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: { message, ...(contactName ? { contactName } : {}) },
      });
    }

    let conversation = await prisma.conversation.findFirst({
      where: { companyId, phone },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          companyId,
          leadId: lead.id,
          contactName,
          phone,
          unreadCount: 1,
          lastMessageText: message,
          lastMessageAt: new Date(),
        },
      });
    } else {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageText: message,
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
        },
      });
    }

    const exists = providerMessageId
      ? await prisma.message.findFirst({ where: { companyId, providerMessageId } })
      : null;

    if (!exists) {
      await prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: "inbound",
          body: message,
          status: "received",
          providerMessageId,
        },
      });
    }

    return res.json({ ok: true, companyId, leadId: lead.id, conversationId: conversation.id });
  } catch (error) {
    console.error("Erro saveLeadFromAutomation:", error);
    return res.status(500).json({ error: "Erro ao salvar lead" });
  }
}

export async function matchRuleFromAutomation(req: Request, res: Response) {
  try {
    const companyId = await getCompanyId(req, res);
    if (!companyId) return;

    const rule = await matchFaqRule(companyId, String(req.body.message || ""));

    if (!rule) {
      return res.json({ matched: false });
    }

    return res.json({
      matched: true,
      id: rule.id,
      name: rule.name,
      responseText: rule.responseText,
    });
  } catch (error) {
    console.error("Erro matchRuleFromAutomation:", error);
    return res.status(500).json({ error: "Erro ao buscar regra" });
  }
}

export async function assistantReplyFromAutomation(req: Request, res: Response) {
  try {
    const companyId = await getCompanyId(req, res);
    if (!companyId) return;

    const message = String(req.body.message || "").trim();
    const conversationId = req.body.conversationId ? String(req.body.conversationId) : undefined;

    if (!message) {
      return res.status(400).json({ error: "message e obrigatoria" });
    }

    const result = await generateAssistantReply({ companyId, conversationId, message });

    if (result.reply && conversationId) {
      await prisma.message.create({
        data: {
          companyId,
          conversationId,
          direction: "outbound",
          body: result.reply,
          status: result.handoff ? "suggested_handoff" : "suggested",
        },
      });
    }

    return res.json(result);
  } catch (error) {
    console.error("Erro assistantReplyFromAutomation:", error);
    return res.status(500).json({ error: "Erro ao gerar resposta IA" });
  }
}

export async function assistantConfigFromAutomation(req: Request, res: Response) {
  try {
    const companyId = await getCompanyId(req, res);
    if (!companyId) return;

    const config = await getOrCreateAssistantConfig(companyId);
    return res.json(config);
  } catch (error) {
    console.error("Erro assistantConfigFromAutomation:", error);
    return res.status(500).json({ error: "Erro ao buscar configuracao IA" });
  }
}

export async function runFollowUps(_req: Request, res: Response) {
  try {
    const results = await processDueFollowUps();

    return res.json({ ok: true, processed: results.length, results });
  } catch (error) {
    console.error("Erro runFollowUps:", error);
    return res.status(500).json({ error: "Erro ao processar follow-ups" });
  }
}
