import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { generateAssistantReply, generateQuickReplies } from "../lib/aiAssistant";
import { sendWhatsAppText } from "../lib/whatsappProvider";

function getId(param: any): string {
  return Array.isArray(param) ? param[0] : param;
}

function removeAlertTags(current: string) {
  return String(current || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !["alerta_humano", "urgente"].includes(item.toLowerCase()))
    .join(", ");
}

// LISTAR CONVERSAS
export async function listConversations(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const { q, unreadOnly, stageId, assignedUserId, alertOnly } = req.query;

    const data = await prisma.conversation.findMany({
      where: {
        companyId,
        isArchived: false,
        ...(typeof q === "string" && q.trim()
          ? {
              OR: [
                { contactName: { contains: q, mode: "insensitive" } },
                { phone: { contains: q } },
                { lastMessageText: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(unreadOnly === "true" ? { unreadCount: { gt: 0 } } : {}),
        ...(alertOnly === "true"
          ? {
              OR: [
                { isHot: true },
                { tags: { contains: "alerta_humano", mode: "insensitive" } },
                { tags: { contains: "urgente", mode: "insensitive" } },
              ],
            }
          : {}),
        ...(typeof stageId === "string" && stageId ? { stageId } : {}),
        ...(typeof assignedUserId === "string" && assignedUserId
          ? { assignedUserId }
          : {}),
      },
      include: {
        stage: true,
        assignedUser: {
          select: { id: true, name: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Erro ao listar" });
  }
}

// DETALHE
export async function getConversationById(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);

    const data = await prisma.conversation.findFirst({
      where: { id, companyId },
      include: {
        lead: true,
        stage: true,
        assignedUser: {
          select: { id: true, name: true },
        },
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!data) {
      return res.status(404).json({ error: "Nao encontrada" });
    }

    if (data.unreadCount > 0 || data.isHot || String(data.tags || "").toLowerCase().includes("alerta_humano") || String(data.tags || "").toLowerCase().includes("urgente")) {
      await prisma.conversation.update({
        where: { id: data.id },
        data: {
          unreadCount: 0,
          isHot: false,
          tags: removeAlertTags(data.tags),
        },
      });
    }

    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Erro" });
  }
}

// ENVIAR MENSAGEM
export async function sendMessage(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);
    const { body } = req.body;

    const conversation = await prisma.conversation.findFirst({
      where: { id, companyId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Não encontrada" });
    }

    const instance = await prisma.whatsappInstance.findFirst({
      where: { companyId, OR: [{ provider: "meta_cloud_api" }, { status: "connected" }] },
      orderBy: { updatedAt: "desc" },
    });

    let providerMessageId: string | null = null;
    let status = "sent";

    if (instance) {
      try {
        const sent = await sendWhatsAppText(instance, conversation.phone, String(body));
        providerMessageId = sent.id || null;
      } catch (error) {
        console.error("Erro ao enviar WhatsApp:", error);
        status = "send_failed";
      }
    } else {
      status = "queued_no_instance";
    }

    const message = await prisma.message.create({
      data: {
        company: {
          connect: { id: companyId },
        },
        conversation: {
          connect: { id: conversation.id },
        },
        direction: "outbound",
        body: String(body),
        status,
        providerMessageId,
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageText: String(body),
        lastMessageAt: new Date(),
        unreadCount: 0,
        isHot: false,
        tags: removeAlertTags(conversation.tags),
      },
    });

    return res.json(message);
  } catch {
    return res.status(500).json({ error: "Erro ao enviar" });
  }
}

// ATUALIZAR
export async function updateConversation(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);
    const { assignedUserId, stageId, followUpAt, followUpText, followUpStatus, ...rest } = req.body;

    const conversation = await prisma.conversation.findFirst({
      where: { id, companyId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Nao encontrada" });
    }

    if (assignedUserId) {
      const membership = await prisma.membership.findFirst({
        where: { companyId, userId: assignedUserId },
      });

      if (!membership) {
        return res.status(400).json({ error: "Responsavel fora da empresa" });
      }
    }

    if (stageId) {
      const stage = await prisma.pipelineStage.findFirst({
        where: { id: stageId, companyId },
      });

      if (!stage) {
        return res.status(400).json({ error: "Etapa fora da empresa" });
      }
    }

    const data = await prisma.conversation.update({
      where: { id },
      data: {
        ...rest,
        assignedUserId: assignedUserId || null,
        stageId: stageId || null,
        ...(followUpAt !== undefined
          ? { followUpAt: followUpAt ? new Date(followUpAt) : null }
          : {}),
        ...(followUpText !== undefined ? { followUpText: String(followUpText || "") } : {}),
        ...(followUpStatus !== undefined ? { followUpStatus: String(followUpStatus || "none") } : {}),
      },
    });

    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Erro ao atualizar" });
  }
}

export async function archiveConversation(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id, companyId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Não encontrada" });
    }

    await prisma.conversation.update({
      where: { id },
      data: {
        isArchived: true,
        unreadCount: 0,
        followUpAt: null,
        followUpText: "",
        followUpStatus: "none",
      },
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Erro archiveConversation:", error);
    return res.status(500).json({ error: "Erro ao excluir conversa" });
  }
}

export async function suggestConversationReply(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id, companyId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Nao encontrada" });
    }

    const result = await generateAssistantReply({
      companyId,
      conversationId: conversation.id,
      message: conversation.lastMessageText || "",
    });

    return res.json(result);
  } catch (error) {
    console.error("Erro suggestConversationReply:", error);
    return res.status(500).json({ error: "Erro ao sugerir resposta" });
  }
}

export async function suggestQuickReplies(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);
    const conversation = await prisma.conversation.findFirst({ where: { id, companyId } });
    if (!conversation) return res.status(404).json({ error: "Nao encontrada" });
    const result = await generateQuickReplies({ companyId, conversationId: conversation.id, message: conversation.lastMessageText || "" });
    return res.json(result);
  } catch (error) {
    console.error("Erro suggestQuickReplies:", error);
    return res.status(500).json({ error: "Erro ao gerar respostas rapidas" });
  }
}
export async function summarizeConversation(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id, companyId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Nao encontrada" });
    }

    const result = await generateAssistantReply({
      companyId,
      conversationId: conversation.id,
      message: conversation.lastMessageText || "",
      mode: "summary",
    });

    return res.json(result);
  } catch (error) {
    console.error("Erro summarizeConversation:", error);
    return res.status(500).json({ error: "Erro ao resumir conversa" });
  }
}

// STAGES
export async function listStages(req: Request, res: Response) {
  const companyId = req.auth!.companyId;

  const count = await prisma.pipelineStage.count({ where: { companyId } });

  if (count === 0) {
    await prisma.pipelineStage.createMany({
      data: [
        { companyId, name: "Novo lead", color: "#2563eb", position: 0 },
        { companyId, name: "Em atendimento", color: "#f59e0b", position: 1 },
        { companyId, name: "Orcamento enviado", color: "#7c3aed", position: 2 },
        { companyId, name: "Follow-up", color: "#0ea5e9", position: 3 },
        { companyId, name: "Fechado", color: "#16a34a", position: 4 },
        { companyId, name: "Perdido", color: "#ef4444", position: 5 },
      ],
    });
  } else if (count < 6) {
    const existing = await prisma.pipelineStage.findMany({ where: { companyId } });
    const names = new Set(existing.map((stage) => stage.name.toLowerCase()));
    const defaults = [
      { name: "Novo lead", color: "#2563eb", position: 0 },
      { name: "Em atendimento", color: "#f59e0b", position: 1 },
      { name: "Orcamento enviado", color: "#7c3aed", position: 2 },
      { name: "Follow-up", color: "#0ea5e9", position: 3 },
      { name: "Fechado", color: "#16a34a", position: 4 },
      { name: "Perdido", color: "#ef4444", position: 5 },
    ].filter((stage) => !names.has(stage.name.toLowerCase()));

    if (defaults.length > 0) {
      await prisma.pipelineStage.createMany({
        data: defaults.map((stage) => ({ ...stage, companyId })),
      });
    }
  }

  const stages = await prisma.pipelineStage.findMany({
    where: { companyId },
    orderBy: { position: "asc" },
  });

  return res.json(stages);
}

// SEED
export async function seedConversations(req: Request, res: Response) {
  return res.json({ ok: true });
}
