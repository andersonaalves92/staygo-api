import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

const NEW_STAGE_NAMES = ["Novo lead", "Em atendimento", "Orcamento enviado", "Follow-up"];
const CLOSED_STAGE_NAMES = ["Fechado", "fechado"];
const LOST_STAGE_NAMES = ["Perdido", "perdido"];
const OLD_NEGOTIATION_STAGES = ["contato iniciado", "proposta enviada", "aguardando resposta"];
const AI_STATUSES = ["ai_sent", "suggested", "suggested_handoff", "send_failed"];

function percent(part: number, total: number) {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : 0;
}

function minutesBetween(start: Date, end: Date) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

export async function getDashboardMetrics(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [
      totalConversations,
      unreadConversations,
      hotLeads,
      activeRules,
      totalLeads,
      newLeads,
      closedLeads,
      lostLeads,
      followUpLeads,
      conversations,
      leadsByStageRaw,
      messages,
      recentConversations,
      assistantConfig,
      dueFollowUps,
      connectedWhatsApps,
    ] = await Promise.all([
      prisma.conversation.count({ where: { companyId } }),
      prisma.conversation.count({ where: { companyId, unreadCount: { gt: 0 } } }),
      prisma.conversation.count({ where: { companyId, isHot: true } }),
      prisma.faqRule.count({ where: { companyId, active: true } }),
      prisma.lead.count({ where: { companyId } }),
      prisma.lead.count({ where: { companyId, stage: { in: ["Novo lead", "novo"] } } }),
      prisma.lead.count({ where: { companyId, stage: { in: CLOSED_STAGE_NAMES } } }),
      prisma.lead.count({ where: { companyId, stage: { in: LOST_STAGE_NAMES } } }),
      prisma.lead.count({
        where: { companyId, stage: { in: [...NEW_STAGE_NAMES.slice(1), ...OLD_NEGOTIATION_STAGES] } },
      }),
      prisma.conversation.findMany({
        where: { companyId, createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.lead.groupBy({
        by: ["stage"],
        where: { companyId },
        _count: { stage: true },
      }),
      prisma.message.findMany({
        where: { companyId, createdAt: { gte: since } },
        select: {
          conversationId: true,
          direction: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.conversation.findMany({
        where: { companyId },
        select: {
          unreadCount: true,
          isHot: true,
          lastMessageAt: true,
          createdAt: true,
          assignedUserId: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      prisma.aiAssistantConfig.findUnique({ where: { companyId } }),
      prisma.conversation.count({
        where: {
          companyId,
          followUpStatus: "scheduled",
          followUpAt: { lte: new Date() },
          followUpSentAt: null,
          isArchived: false,
        },
      }),
      prisma.whatsappInstance.count({ where: { companyId, status: "connected" } }),
    ]);

    const conversationsByDayMap = new Map<string, number>();
    for (const item of conversations) {
      const key = item.createdAt.toISOString().slice(0, 10);
      conversationsByDayMap.set(key, (conversationsByDayMap.get(key) || 0) + 1);
    }

    const conversationsByDay = Array.from(conversationsByDayMap.entries()).map(
      ([date, total]) => ({ date, total })
    );

    const leadsByStage = leadsByStageRaw.map((item) => ({
      stage: item.stage,
      total: item._count.stage,
    }));

    const inboundMessages = messages.filter((m) => m.direction === "inbound").length;
    const outboundMessages = messages.filter((m) => m.direction === "outbound").length;
    const aiMessages = messages.filter(
      (m) => m.direction === "outbound" && AI_STATUSES.includes(m.status)
    ).length;
    const totalMessages = inboundMessages + outboundMessages;
    const responseBalance = percent(outboundMessages, totalMessages);
    const assignmentRate = percent(
      recentConversations.filter((item) => item.assignedUserId).length,
      recentConversations.length
    );
    const hotLeadRate = percent(hotLeads, totalConversations);
    const conversionRate = percent(closedLeads, totalLeads);

    const byConversation = new Map<string, typeof messages>();
    for (const message of messages) {
      const list = byConversation.get(message.conversationId) || [];
      list.push(message);
      byConversation.set(message.conversationId, list);
    }

    const responseMinutes: number[] = [];
    for (const list of byConversation.values()) {
      for (let index = 0; index < list.length; index += 1) {
        const message = list[index];
        if (message.direction !== "inbound") continue;

        const nextOutbound = list
          .slice(index + 1)
          .find((candidate) => candidate.direction === "outbound");

        if (nextOutbound) {
          responseMinutes.push(minutesBetween(message.createdAt, nextOutbound.createdAt));
        }
      }
    }

    const avgFirstResponseMinutes = average(responseMinutes);
    const aiCoverage = percent(aiMessages, outboundMessages);
    const estimatedMinutesSaved = aiMessages * 3;

    return res.json({
      totalConversations,
      unreadConversations,
      hotLeads,
      activeRules,
      totalLeads,
      newLeads,
      closedLeads,
      lostLeads,
      followUpLeads,
      conversionRate,
      conversationsByDay,
      leadsByStage,
      messagesSummary: {
        inbound: inboundMessages,
        outbound: outboundMessages,
        ai: aiMessages,
      },
      sales: {
        openLeads: Math.max(0, totalLeads - closedLeads - lostLeads),
        dueFollowUps,
        connectedWhatsApps,
        avgFirstResponseMinutes,
        aiCoverage,
        estimatedMinutesSaved,
        estimatedHoursSaved: Number((estimatedMinutesSaved / 60).toFixed(1)),
        assistantEnabled: Boolean(assistantConfig?.enabled),
      },
      behavior: {
        responseBalance,
        assignmentRate,
        hotLeadRate,
        automationCoverage: percent(activeRules + aiMessages, Math.max(totalLeads, 1)),
      },
      insights: [
        unreadConversations > 0
          ? `${unreadConversations} conversas aguardam resposta.`
          : "Nenhuma conversa pendente agora.",
        dueFollowUps > 0
          ? `${dueFollowUps} follow-ups vencidos precisam ser processados.`
          : "Follow-ups em dia.",
        aiMessages > 0
          ? `IA participou de ${aiMessages} respostas nos ultimos 30 dias.`
          : assistantConfig?.enabled
            ? "IA esta ativa, mas ainda sem respostas registradas no periodo."
            : "Ative a IA para medir economia de atendimento.",
        avgFirstResponseMinutes > 0
          ? `Tempo medio ate resposta: ${avgFirstResponseMinutes} minutos.`
          : "Ainda nao ha pares de mensagens suficientes para medir resposta.",
      ],
    });
  } catch (error) {
    console.error("Erro em getDashboardMetrics:", error);
    return res.status(500).json({ error: "Erro ao buscar metricas do dashboard" });
  }
}

export async function getOnboardingStatus(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const [company, whatsappInstances, assistantConfig, knowledgeItems, messages, members] =
      await Promise.all([
        prisma.company.findUnique({ where: { id: companyId } }),
        prisma.whatsappInstance.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
        prisma.aiAssistantConfig.findUnique({ where: { companyId } }),
        prisma.knowledgeItem.count({ where: { companyId, active: true } }),
        prisma.message.count({ where: { companyId } }),
        prisma.membership.count({ where: { companyId } }),
      ]);

    const hasWhatsapp = whatsappInstances.length > 0;
    const whatsappConnected = whatsappInstances.some((item) => item.status === "connected");
    const assistantConfigured = Boolean(
      assistantConfig &&
        (assistantConfig.businessDescription.trim() ||
          assistantConfig.instructions.trim() ||
          knowledgeItems > 0)
    );
    const assistantEnabled = Boolean(assistantConfig?.enabled);

    const steps = [
      {
        key: "company",
        title: "Empresa criada",
        done: Boolean(company),
        action: "Conta pronta para operar",
        href: "/",
      },
      {
        key: "whatsapp",
        title: "WhatsApp conectado",
        done: hasWhatsapp && whatsappConnected,
        action: hasWhatsapp ? "Atualizar status do WhatsApp" : "Gerar QR Code",
        href: "/whatsapp",
      },
      {
        key: "assistant",
        title: "IA configurada",
        done: assistantConfigured && assistantEnabled,
        action: assistantConfigured ? "Ativar assistente IA" : "Adicionar contexto da empresa",
        href: "/rules",
      },
      {
        key: "knowledge",
        title: "Conhecimento cadastrado",
        done: knowledgeItems > 0,
        action: "Cadastrar servicos, precos e perguntas",
        href: "/rules",
      },
      {
        key: "team",
        title: "Equipe revisada",
        done: members > 0,
        action: "Adicionar usuarios quando precisar",
        href: "/team",
      },
      {
        key: "test",
        title: "Teste real recebido",
        done: messages > 0,
        action: "Enviar uma mensagem de teste",
        href: "/conversations",
      },
    ];

    const completed = steps.filter((step) => step.done).length;
    const progress = Math.round((completed / steps.length) * 100);

    return res.json({
      progress,
      completed,
      total: steps.length,
      readyToSell: progress >= 80,
      companyName: company?.name || "",
      steps,
    });
  } catch (error) {
    console.error("Erro em getOnboardingStatus:", error);
    return res.status(500).json({ error: "Erro ao buscar onboarding" });
  }
}
