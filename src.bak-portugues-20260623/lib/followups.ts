import { sendWhatsAppText } from "./whatsappProvider";
import { prisma } from "./prisma";

export async function processDueFollowUps(limit = 30) {
  const now = new Date();
  const due = await prisma.conversation.findMany({
    where: {
      followUpAt: { lte: now },
      followUpSentAt: null,
      followUpStatus: { in: ["scheduled", "failed"] },
      isArchived: false,
    },
    include: {
      company: {
        include: {
          whatsappInstances: {
            where: { OR: [{ provider: "meta_cloud_api" }, { status: "connected" }] },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
        },
      },
    },
    take: limit,
    orderBy: { followUpAt: "asc" },
  });

  const results = [];

  for (const conversation of due) {
    const instance = conversation.company.whatsappInstances[0];
    const text =
      conversation.followUpText ||
      "Oi, passando para saber se ficou alguma duvida. Posso te ajudar a seguir com o atendimento?";

    if (!instance) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { followUpStatus: "no_whatsapp" },
      });
      results.push({ id: conversation.id, status: "no_whatsapp" });
      continue;
    }

    try {
      const sent = await sendWhatsAppText(instance, conversation.phone, text);
      const providerMessageId = sent.id || null;

      await prisma.message.create({
        data: {
          companyId: conversation.companyId,
          conversationId: conversation.id,
          direction: "outbound",
          body: text,
          status: "followup_sent",
          providerMessageId,
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          followUpSentAt: now,
          followUpStatus: "sent",
          lastMessageText: text,
          lastMessageAt: now,
        },
      });

      results.push({ id: conversation.id, status: "sent" });
    } catch (error) {
      console.error("Erro processDueFollowUps:", error);
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { followUpStatus: "failed" },
      });
      results.push({ id: conversation.id, status: "failed" });
    }
  }

  return results;
}

export function startFollowUpScheduler() {
  const intervalMs = Number(process.env.FOLLOWUP_INTERVAL_MS || 300000);

  setInterval(async () => {
    try {
      const results = await processDueFollowUps();
      if (results.length > 0) {
        console.log(`Follow-ups processados: ${results.length}`);
      }
    } catch (error) {
      console.error("Erro no scheduler de follow-up:", error);
    }
  }, intervalMs);
}
