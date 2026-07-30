import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { generateAssistantReply } from "../lib/aiAssistant";
import { getEvolutionMediaBase64 } from "../lib/evolution";
import { canSendWhatsApp, getMetaMediaBytes, sendWhatsAppText } from "../lib/whatsappProvider";

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function automaticFollowUpText() {
  return "Ola! Estou passando para saber se voce conseguiu ver minha mensagem. Posso te ajudar a seguir com o atendimento?";
}

function pendingFollowUpReset() {
  return {
    followUpAt: null,
    followUpText: "",
    followUpSentAt: null,
    followUpStatus: "none",
  };
}

function removeAlertTags(current: string) {
  return String(current || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !["alerta_humano", "urgente"].includes(item.toLowerCase()))
    .join(", ");
}

function mergeTags(current: string, additions: string[]) {
  const set = new Set(
    String(current || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  additions.forEach((item) => set.add(item));
  return Array.from(set).join(", ");
}

function normalizePhone(value: string) {
  return String(value || "").replace(/\D/g, "");
}

function isGroupJid(value: string) {
  const jid = String(value || "").toLowerCase();
  return jid.includes("@g.us") || jid.includes("-") && jid.endsWith("@g.us");
}

function alertTextForHuman(phone: string, text: string) {
  const shortText = String(text || "").replace(/\s+/g, " ").slice(0, 260);
  return [
    "StayGoBot: alerta humano urgente.",
    "Um lead precisa de resposta imediata.",
    "Telefone: " + phone,
    "Mensagem: " + shortText,
  ].join("\n");
}

function validateEvolutionWebhook(req: Request) {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected) return true;
  const received = req.headers["x-staygobot-webhook-token"];
  const token = Array.isArray(received) ? received[0] : received;
  return token === expected;
}

function isÁudioMessage(raw: any) {
  return Boolean(raw?.message?.áudioMessage);
}

function áudioExtension(mimetype: string) {
  if (mimetype.includes("mpeg") || mimetype.includes("mp3")) return "mp3";
  if (mimetype.includes("wav")) return "wav";
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("webm")) return "webm";
  return "ogg";
}

async function transcribeÁudioBase64(base64: string, mimetype: string) {
  if (!process.env.OPENAI_API_KEY || !base64) return "";
  const cleanBase64 = base64.includes(",") ? base64.split(",").pop() || "" : base64;
  const bytes = Buffer.from(cleanBase64, "base64");
  if (bytes.length === 0) return "";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimetype || "áudio/ogg" }), "áudio." + áudioExtension(mimetype || "áudio/ogg"));
  form.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", "pt");
  const response = await fetch("https://api.openai.com/v1/áudio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Erro ao transcrever áudio");
  return String(data?.text || "").trim();
}

async function transcribeEvolutionÁudio(instanceName: string, raw: any) {
  if (!isÁudioMessage(raw) || !instanceName) return "";
  const mimetype = raw?.message?.áudioMessage?.mimetype || "áudio/ogg";
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const base64 = await getEvolutionMediaBase64(instanceName, raw);
      const transcript = await transcribeÁudioBase64(base64, mimetype);
      return transcript ? "[Áudio transcrito] " + transcript : "[Áudio]";
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(700 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Nao foi possivel baixar/transcrever áudio");
}
function extractMessageText(raw: any): string {
  return (
    raw?.message?.conversation ||
    raw?.message?.extendedTextMessage?.text ||
    raw?.message?.imageMessage?.caption ||
    raw?.message?.videoMessage?.caption ||
    (raw?.message?.áudioMessage ? "[Áudio]" : "") ||
    (raw?.message?.imageMessage ? "[Imagem]" : "") ||
    (raw?.message?.videoMessage ? "[Video]" : "") ||
    (raw?.message?.documentMessage ? "[Documento]" : "") ||
    raw?.text ||
    raw?.body ||
    ""
  );
}

function isSupportedEvent(event: string) {
  const normalized = String(event || "").toUpperCase();
  return (
    normalized.includes("MESSAGE") ||
    normalized.includes("MESSAGES_UPSERT")
  );
}

function isConnectionEvent(event: string) {
  const normalized = String(event || "").toUpperCase();
  return normalized.includes("CONNECTION");
}

function normalizeConnectionStatus(payload: any) {
  const rawStatus =
    payload?.data?.state ||
    payload?.data?.status ||
    payload?.data?.connection ||
    payload?.state ||
    payload?.status ||
    payload?.connection ||
    "";

  const status = String(rawStatus || "").toLowerCase();

  if (status.includes("open") || status.includes("connect")) return "connected";
  if (status.includes("close") || status.includes("logout") || status.includes("disconnect")) {
    return "disconnected";
  }

  return status || "connecting";
}

function extractInstanceName(payload: any, req: Request) {
  const headerInstance = req.headers["x-instance-name"];

  return String(
    payload?.instance ||
      payload?.instanceName ||
      payload?.data?.instance ||
      payload?.data?.instanceName ||
      payload?.data?.instanceId ||
      (Array.isArray(headerInstance) ? headerInstance[0] : headerInstance) ||
      ""
  ).trim();
}


function validateMetaWebhook(req: Request) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return true;
  const received = req.headers["x-staygobot-meta-token"];
  const token = Array.isArray(received) ? received[0] : received;
  return !token || token === expected;
}

function extractMetaMessageText(message: any) {
  return (
    message?.text?.body ||
    message?.button?.text ||
    message?.interactive?.button_reply?.title ||
    message?.interactive?.list_reply?.title ||
    message?.image?.caption ||
    message?.video?.caption ||
    (message?.áudio ? "[Áudio]" : "") ||
    (message?.image ? "[Imagem]" : "") ||
    (message?.video ? "[Video]" : "") ||
    (message?.document ? "[Documento]" : "") ||
    ""
  );
}

async function transcribeMetaÁudio(instance: any, message: any) {
  const mediaId = message?.áudio?.id || message?.voice?.id;
  if (!mediaId || !instance?.metaAccessToken) return "[Áudio]";
  const mimetype = message?.áudio?.mime_type || "áudio/ogg";
  const bytes = await getMetaMediaBytes(mediaId, instance.metaAccessToken);
  const transcript = await transcribeÁudioBase64(bytes.toString("base64"), mimetype);
  return transcript ? "[Áudio transcrito] " + transcript : "[Áudio]";
}

async function processInboundWhatsApp(params: {
  instance: any;
  phone: string;
  text: string;
  providerMessageId?: string | null;
}) {
  const { instance, phone, text, providerMessageId = null } = params;
  const companyId = instance.companyId;

  let lead = await prisma.lead.findFirst({ where: { companyId, phone }, orderBy: { createdAt: "asc" } });

  if (!lead) {
    lead = await prisma.lead.create({ data: { companyId, phone, contactName: null, message: text, stage: "Novo lead" } });
  } else {
    await prisma.lead.update({ where: { id: lead.id }, data: { message: text } });
  }

  let conversation = await prisma.conversation.findFirst({ where: { companyId, phone }, orderBy: { createdAt: "asc" } });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { companyId, leadId: lead.id, contactName: lead.contactName, phone, unreadCount: 1, lastMessageText: text, lastMessageAt: new Date(), ...pendingFollowUpReset() },
    });
  } else {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageText: text, lastMessageAt: new Date(), unreadCount: { increment: 1 }, ...pendingFollowUpReset() },
    });
  }

  const alreadyExists = providerMessageId ? await prisma.message.findFirst({ where: { companyId, providerMessageId } }) : null;
  if (!alreadyExists) {
    await prisma.message.create({ data: { companyId, conversationId: conversation.id, direction: "inbound", body: text, status: "received", providerMessageId } });
  }

  let aiReply: string | null = null;
  let aiStatus: string | null = null;

  try {
    const result = await generateAssistantReply({ companyId, conversationId: conversation.id, message: text });

    if (result.reply && result.enabled) {
      aiReply = result.reply;
      const suggestOnly = result.responseMode === "suggest";
      aiStatus = result.handoff ? "suggested_handoff" : suggestOnly ? "suggested" : "sent";
      const instanceCanSend = canSendWhatsApp(instance);

      if (!instanceCanSend && !suggestOnly) {
        await prisma.message.create({ data: { companyId, conversationId: conversation.id, direction: "outbound", body: result.reply, status: result.handoff ? "queued_handoff_instance_disconnected" : "queued_instance_disconnected" } });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { isHot: true, tags: mergeTags(conversation.tags, ["whatsapp_desconectado"]), followUpAt: minutesFromNow(10), followUpText: result.reply, followUpSentAt: null, followUpStatus: "scheduled" } });
      } else if (suggestOnly) {
        await prisma.message.create({ data: { companyId, conversationId: conversation.id, direction: "outbound", body: result.reply, status: result.handoff ? "suggested_handoff" : "suggested" } });
        if (result.handoff) {
          const config = await prisma.aiAssistantConfig.findUnique({ where: { companyId } });
          conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { isHot: true, tags: mergeTags(conversation.tags, ["alerta_humano", "urgente"]) } });
          const alertPhone = normalizePhone(config?.urgentAlertPhone || "");
          if (alertPhone && instanceCanSend) {
            try { await sendWhatsAppText(instance, alertPhone, alertTextForHuman(phone, text)); } catch (alertError) { console.error("Erro ao enviar alerta humano:", alertError); }
          }
        }
      } else {
        let providerAiMessageId: string | null = null;
        let status = result.handoff ? "ai_sent_handoff" : "ai_sent";
        try {
          const sent = await sendWhatsAppText(instance, phone, result.reply);
          providerAiMessageId = sent.id || null;
        } catch (sendError) {
          console.error(result.handoff ? "Erro ao enviar resposta de handoff:" : "Erro ao enviar resposta IA:", sendError);
          status = result.handoff ? "send_failed_handoff" : "send_failed";
          aiStatus = "send_failed";
        }

        await prisma.message.create({ data: { companyId, conversationId: conversation.id, direction: "outbound", body: result.reply, status, providerMessageId: providerAiMessageId } });

        if (result.handoff) {
          const config = await prisma.aiAssistantConfig.findUnique({ where: { companyId } });
          conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageText: result.reply, lastMessageAt: new Date(), unreadCount: 0, isHot: true, tags: mergeTags(conversation.tags, ["alerta_humano", "urgente"]) } });
          const alertPhone = normalizePhone(config?.urgentAlertPhone || "");
          if (alertPhone && instanceCanSend) {
            try { await sendWhatsAppText(instance, alertPhone, alertTextForHuman(phone, text)); } catch (alertError) { console.error("Erro ao enviar alerta humano:", alertError); }
          }
        } else if (status === "ai_sent") {
          await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageText: result.reply, lastMessageAt: new Date(), unreadCount: 0, isHot: false, tags: removeAlertTags(conversation.tags), followUpAt: minutesFromNow(Number(process.env.AUTO_FOLLOWUP_AFTER_AI_MINUTES || 120)), followUpText: automaticFollowUpText(), followUpSentAt: null, followUpStatus: "scheduled" } });
        } else {
          await prisma.conversation.update({ where: { id: conversation.id }, data: { followUpAt: minutesFromNow(Number(process.env.AUTO_RETRY_AFTER_SEND_FAIL_MINUTES || 15)), followUpText: result.reply, followUpSentAt: null, followUpStatus: "scheduled" } });
        }
      }
    }
  } catch (aiError) {
    console.error("Erro IA no webhook:", aiError);
    aiStatus = "error";
  }

  return { companyId, leadId: lead.id, conversationId: conversation.id, aiReply, aiStatus };
}

export async function metaWebhookVerify(req: Request, res: Response) {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
}

export async function metaWebhook(req: Request, res: Response) {
  try {
    if (!validateMetaWebhook(req)) return res.status(401).json({ error: "Webhook nao autorizado" });

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const results = [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        const phoneNumberId = value?.metadata?.phone_number_id;
        const messages = Array.isArray(value?.messages) ? value.messages : [];

        if (!messages.length) continue;
        const instance = await prisma.whatsappInstance.findFirst({
          where: { provider: "meta_cloud_api", metaPhoneNumberId: String(phoneNumberId || "") },
        });

        if (!instance) {
          results.push({ ignored: true, reason: "phone_number_id_nao_vinculado", phoneNumberId });
          continue;
        }

        if (instance.status !== "official_connected") {
          await prisma.whatsappInstance.update({ where: { id: instance.id }, data: { status: "official_connected" } });
        }

        for (const message of messages) {
          const phone = normalizePhone(message?.from || "");
          if (!phone) continue;
          let text = extractMetaMessageText(message);
          if (message?.áudio) {
            try { text = await transcribeMetaÁudio(instance, message); } catch (error) { console.error("Erro ao transcrever áudio Meta:", error); text = "[Áudio recebido, mas nao foi possivel transcrever automaticamente]"; }
          }
          if (!text) continue;
          const result = await processInboundWhatsApp({ instance, phone, text, providerMessageId: message?.id || null });
          results.push(result);
        }
      }
    }

    return res.json({ ok: true, results });
  } catch (error) {
    console.error("Erro no metaWebhook:", error);
    return res.status(500).json({ error: "Erro no webhook Meta" });
  }
}

export async function evolutionWebhook(req: Request, res: Response) {
  try {
    if (!validateEvolutionWebhook(req)) {
      return res.status(401).json({ error: "Webhook nao autorizado" });
    }
    const payload = req.body;

    const event =
      payload?.event ||
      payload?.type ||
      payload?.data?.event ||
      "";

    const instanceName = extractInstanceName(payload, req);

    if (isConnectionEvent(event)) {
      if (!instanceName) {
        return res.json({ ok: true, ignored: true, reason: "instancia ausente" });
      }

      const status = normalizeConnectionStatus(payload);
      const updated = await prisma.whatsappInstance.updateMany({
        where: { instanceName },
        data: { status },
      });

      return res.json({
        ok: true,
        event,
        instanceName,
        status,
        updated: updated.count,
      });
    }

    if (!isSupportedEvent(event)) {
      return res.json({ ok: true, ignored: true, reason: "evento não tratado" });
    }

    const raw =
      payload?.data?.key
        ? payload.data
        : payload?.data?.message?.key
          ? payload.data.message
          : payload?.data?.messages?.[0] ||
            payload?.data?.message ||
            payload?.data ||
            payload;

    const remoteJid =
      raw?.key?.remoteJidAlt ||
      raw?.remoteJidAlt ||
      raw?.key?.remoteJid ||
      raw?.remoteJid ||
      raw?.jid ||
      "";

    const fromMe =
      raw?.key?.fromMe === true ||
      raw?.fromMe === true;

    if (isGroupJid(remoteJid)) {
      return res.json({ ok: true, ignored: true, reason: "grupo_whatsapp_sem_ia" });
    }

    const providerMessageId = raw?.key?.id || null;
    const phone = normalizePhone((remoteJid || "").split("@")[0]);
    let text = extractMessageText(raw);

    if (isÁudioMessage(raw)) {
      try {
        text = await transcribeEvolutionÁudio(instanceName, raw);
      } catch (transcriptionError) {
        console.error("Erro ao transcrever áudio:", transcriptionError);
        text = "[Áudio recebido, mas nao foi possivel transcrever automaticamente]";
      }
    }

    if (!phone) {
      return res.json({ ok: true, ignored: true, reason: "telefone ausente" });
    }

    if (!text) {
      return res.json({ ok: true, ignored: true, reason: "mensagem sem texto" });
    }

    if (fromMe) {
      return res.json({ ok: true, ignored: true, reason: "mensagem do próprio sistema" });
    }

    let instance = instanceName
      ? await prisma.whatsappInstance.findUnique({
          where: { instanceName },
        })
      : null;

    if (!instance && !instanceName) {
      const instances = await prisma.whatsappInstance.findMany({
        take: 2,
        orderBy: { createdAt: "asc" },
      });

      if (instances.length === 1) {
        instance = instances[0];
      }
    }

    if (!instance) {
      return res.status(400).json({
        error: "Instancia WhatsApp nao vinculada a uma empresa",
      });
    }

    const companyId = instance.companyId;

    let lead = await prisma.lead.findFirst({
      where: {
        companyId,
        phone,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          companyId,
          phone,
          contactName: null,
          message: text,
          stage: "Novo lead",
        },
      });
    } else {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          message: text,
        },
      });
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        companyId,
        phone,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          companyId,
          leadId: lead.id,
          contactName: lead.contactName,
          phone,
          unreadCount: 1,
          lastMessageText: text,
          lastMessageAt: new Date(),
          ...pendingFollowUpReset(),
        },
      });
    } else {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageText: text,
          lastMessageAt: new Date(),
          unreadCount: {
            increment: 1,
          },
          ...pendingFollowUpReset(),
        },
      });
    }

    const alreadyExists = providerMessageId
      ? await prisma.message.findFirst({
          where: {
            companyId,
            providerMessageId,
          },
        })
      : null;

    if (!alreadyExists) {
      await prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          direction: "inbound",
          body: text,
          status: "received",
          providerMessageId,
        },
      });
    }

    let aiReply: string | null = null;
    let aiStatus: string | null = null;

    try {
      const result = await generateAssistantReply({
        companyId,
        conversationId: conversation.id,
        message: text,
      });

      if (result.reply && result.enabled) {
        aiReply = result.reply;
        const suggestOnly = result.responseMode === "suggest";
        aiStatus = result.handoff ? "suggested_handoff" : suggestOnly ? "suggested" : "sent";

        const instanceCanSend = canSendWhatsApp(instance);

        if (!instanceCanSend && !suggestOnly) {
          await prisma.message.create({
            data: {
              companyId,
              conversationId: conversation.id,
              direction: "outbound",
              body: result.reply,
              status: result.handoff ? "queued_handoff_instance_disconnected" : "queued_instance_disconnected",
            },
          });

          await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              isHot: true,
              tags: mergeTags(conversation.tags, ["whatsapp_desconectado"]),
              followUpAt: minutesFromNow(10),
              followUpText: result.reply,
              followUpSentAt: null,
              followUpStatus: "scheduled",
            },
          });
        } else if (suggestOnly) {
          await prisma.message.create({
            data: {
              companyId,
              conversationId: conversation.id,
              direction: "outbound",
              body: result.reply,
              status: result.handoff ? "suggested_handoff" : "suggested",
            },
          });

          if (result.handoff) {
            const config = await prisma.aiAssistantConfig.findUnique({ where: { companyId } });
            conversation = await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                isHot: true,
                tags: mergeTags(conversation.tags, ["alerta_humano", "urgente"]),
              },
            });

            const alertPhone = normalizePhone(config?.urgentAlertPhone || "");
            if (alertPhone && instanceCanSend) {
              try {
                await sendWhatsAppText(instance, alertPhone, alertTextForHuman(phone, text));
              } catch (alertError) {
                console.error("Erro ao enviar alerta humano:", alertError);
              }
            }
          }
        } else if (!result.handoff) {
          try {
            const sent = await sendWhatsAppText(instance, phone, result.reply);
            const providerAiMessageId = sent.id || null;

            await prisma.message.create({
              data: {
                companyId,
                conversationId: conversation.id,
                direction: "outbound",
                body: result.reply,
                status: "ai_sent",
                providerMessageId: providerAiMessageId,
              },
            });

            await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                lastMessageText: result.reply,
                lastMessageAt: new Date(),
                unreadCount: 0,
                isHot: false,
                tags: removeAlertTags(conversation.tags),
                followUpAt: minutesFromNow(Number(process.env.AUTO_FOLLOWUP_AFTER_AI_MINUTES || 120)),
                followUpText: automaticFollowUpText(),
                followUpSentAt: null,
                followUpStatus: "scheduled",
              },
            });
          } catch (sendError) {
            console.error("Erro ao enviar resposta IA:", sendError);
            aiStatus = "send_failed";

            await prisma.message.create({
              data: {
                companyId,
                conversationId: conversation.id,
                direction: "outbound",
                body: result.reply,
                status: "send_failed",
              },
            });

            await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                followUpAt: minutesFromNow(Number(process.env.AUTO_RETRY_AFTER_SEND_FAIL_MINUTES || 15)),
                followUpText: result.reply,
                followUpSentAt: null,
                followUpStatus: "scheduled",
              },
            });
          }
        } else {
          let providerAiMessageId: string | null = null;
          let handoffMessageStatus = "ai_sent_handoff";

          try {
            const sent = await sendWhatsAppText(instance, phone, result.reply);
            providerAiMessageId = sent.id || null;
          } catch (sendError) {
            console.error("Erro ao enviar resposta de handoff:", sendError);
            handoffMessageStatus = "send_failed_handoff";
          }

          await prisma.message.create({
            data: {
              companyId,
              conversationId: conversation.id,
              direction: "outbound",
              body: result.reply,
              status: handoffMessageStatus,
              providerMessageId: providerAiMessageId,
            },
          });

          const config = await prisma.aiAssistantConfig.findUnique({ where: { companyId } });
          conversation = await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              lastMessageText: result.reply,
              lastMessageAt: new Date(),
              unreadCount: 0,
              isHot: true,
              tags: mergeTags(conversation.tags, ["alerta_humano", "urgente"]),
            },
          });

          const alertPhone = normalizePhone(config?.urgentAlertPhone || "");
          if (alertPhone && instanceCanSend) {
            try {
              await sendWhatsAppText(instance, alertPhone, alertTextForHuman(phone, text));
            } catch (alertError) {
              console.error("Erro ao enviar alerta humano:", alertError);
            }
          }
        }
      }
    } catch (aiError) {
      console.error("Erro IA no webhook:", aiError);
      aiStatus = "error";
    }

    return res.json({
      ok: true,
      companyId,
      leadId: lead.id,
      conversationId: conversation.id,
      aiReply,
      aiStatus,
    });
  } catch (error) {
    console.error("Erro no evolutionWebhook:", error);
    return res.status(500).json({ error: "Erro no webhook" });
  }
}
