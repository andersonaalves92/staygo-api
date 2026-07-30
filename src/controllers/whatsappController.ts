import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  connectEvolutionInstance,
  createEvolutionInstance,
  extractQrCode,
  getEvolutionConnectionState,
  hasEvolutionConfig,
  setEvolutionWebhook,
} from "../lib/evolution";

function slugInstanceName(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function createOrConnectEvolution(instanceName: string, shouldCreateFirst: boolean) {
  if (shouldCreateFirst) {
    return createEvolutionInstance(instanceName);
  }

  try {
    return await connectEvolutionInstance(instanceName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("does not exist")) {
      return createEvolutionInstance(instanceName);
    }
    throw error;
  }
}

export async function listWhatsAppInstances(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const instances = await prisma.whatsappInstance.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
    });

    return res.json(instances);
  } catch (error) {
    return res.status(500).json({ error: "Erro" });
  }
}

export async function connectWhatsApp(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    const currentUser = req.auth?.userId
      ? await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { isPlatformAdmin: true } })
      : null;

    if (!currentUser?.isPlatformAdmin && process.env.ALLOW_LEGACY_QR !== "true") {
      return res.status(403).json({
        error: "QR Code legado bloqueado. Use a WhatsApp Cloud API oficial da Meta para producao.",
      });
    }

    const requestedInstanceName = slugInstanceName(String(req.body.instanceName || "").trim());
    const instanceName = requestedInstanceName || `staygobot-${companyId.slice(0, 12)}`;

    const existing = await prisma.whatsappInstance.findFirst({
      where: { companyId, provider: "evolution_qr" },
    });

    let result;
    let qrCode = "";

    if (existing) {
      result = await prisma.whatsappInstance.update({
        where: { id: existing.id },
        data: { instanceName, status: "connecting" },
      });
    } else {
      result = await prisma.whatsappInstance.create({
        data: { companyId, instanceName, provider: "evolution_qr", connectionMode: "qr_test", status: "connecting" },
      });
    }

    if (hasEvolutionConfig()) {
      try {
        const created = await createOrConnectEvolution(instanceName, !existing);

        qrCode = extractQrCode(created);
        result = await prisma.whatsappInstance.update({
          where: { id: result.id },
          data: { qrCode: qrCode || result.qrCode, status: qrCode ? "qrcode" : "connecting" },
        });

        try {
          await setEvolutionWebhook(instanceName);
        } catch (webhookError) {
          console.error("Erro ao configurar webhook Evolution:", webhookError);
        }
      } catch (error) {
        console.error("Erro Evolution connectWhatsApp:", error);
      }
    }

    return res.json({
      ...result,
      qrCode,
      evolutionConfigured: hasEvolutionConfig(),
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro" });
  }
}

export async function getWhatsAppQrCode(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const id = String(req.params.id);

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const instance = await prisma.whatsappInstance.findFirst({
      where: { id, companyId },
    });

    if (!instance) {
      return res.status(404).json({ error: "Instancia nao encontrada" });
    }

    if (instance.provider === "meta_cloud_api") {
      return res.status(400).json({ error: "Instancia oficial Meta nao usa QR Code." });
    }

    if (!hasEvolutionConfig()) {
      return res.json({
        ...instance,
        qrCode: instance.qrCode,
        evolutionConfigured: false,
      });
    }

    const safeInstanceName = slugInstanceName(instance.instanceName);
    const data = await createOrConnectEvolution(safeInstanceName, false);
    const qrCode = extractQrCode(data);

    const updated = await prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        instanceName: safeInstanceName,
        qrCode: qrCode || instance.qrCode,
        status: qrCode ? "qrcode" : "connecting",
      },
    });

    return res.json({
      ...updated,
      qrCode: qrCode || updated.qrCode,
      evolutionConfigured: true,
    });
  } catch (error) {
    console.error("Erro getWhatsAppQrCode:", error);
    return res.status(500).json({ error: "Erro ao buscar QR Code" });
  }
}

export async function refreshWhatsAppStatus(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const id = String(req.params.id);

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const instance = await prisma.whatsappInstance.findFirst({
      where: { id, companyId },
    });

    if (!instance) {
      return res.status(404).json({ error: "Instancia nao encontrada" });
    }

    if (instance.provider === "meta_cloud_api") {
      const status = instance.metaPhoneNumberId && instance.metaAccessToken ? "official_configured" : "pending_setup";
      const updated = await prisma.whatsappInstance.update({ where: { id: instance.id }, data: { status } });
      return res.json({ ...updated, evolutionConfigured: false, officialProvider: true });
    }

    if (!hasEvolutionConfig()) {
      return res.json({ ...instance, evolutionConfigured: false });
    }

    const data = await getEvolutionConnectionState(instance.instanceName);
    const state =
      data?.instance?.state ||
      data?.state ||
      data?.data?.state ||
      data?.connectionState ||
      instance.status;

    const normalizedStatus = String(state).toLowerCase().includes("open")
      ? "connected"
      : String(state).toLowerCase();

    const updated = await prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: normalizedStatus },
    });

    return res.json({ ...updated, evolutionConfigured: true });
  } catch (error) {
    console.error("Erro refreshWhatsAppStatus:", error);
    return res.status(500).json({ error: "Erro ao atualizar status" });
  }
}


export async function getWhatsAppSettings(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    if (!companyId) return res.status(401).json({ error: "Nao autenticado" });

    const [company, config, officialInstance] = await Promise.all([
      prisma.company.findUnique({
        where: { id: companyId },
        select: {
          plan: true,
          planName: true,
          expiresAt: true,
          maxUsers: true,
          maxMessages: true,
          whatsappConnectionMode: true,
          whatsappPhoneOption: true,
          whatsappDesiredPhone: true,
          whatsappOfficialStatus: true,
        },
      }),
      prisma.aiAssistantConfig.upsert({
        where: { companyId },
        create: { companyId },
        update: {},
      }),
      prisma.whatsappInstance.findFirst({
        where: { companyId, provider: "meta_cloud_api" },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    return res.json({
      plan: company,
      responseMode: config.responseMode || "auto",
      openAiKeyConfigured: Boolean(config.openAiApiKey),
      urgentAlertPhone: config.urgentAlertPhone || "",
      whatsapp: company
        ? {
            connectionMode: company.whatsappConnectionMode,
            phoneOption: company.whatsappPhoneOption,
            desiredPhone: company.whatsappDesiredPhone,
            officialStatus: company.whatsappOfficialStatus,
            metaBusinessId: officialInstance?.metaBusinessId || "",
            metaWabaId: officialInstance?.metaWabaId || "",
            metaPhoneNumberId: officialInstance?.metaPhoneNumberId || "",
            metaAccessTokenConfigured: Boolean(officialInstance?.metaAccessToken),
            webhookUrl: "https://app.staygobot.com/api/webhooks/meta",
          }
        : null,
    });
  } catch (error) {
    console.error("Erro getWhatsAppSettings:", error);
    return res.status(500).json({ error: "Erro ao buscar configuracoes" });
  }
}

export async function updateWhatsAppSettings(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    if (!companyId) return res.status(401).json({ error: "Nao autenticado" });

    const responseMode = req.body?.responseMode === "suggest" ? "suggest" : "auto";
    const openAiApiKey = String(req.body?.openAiApiKey || "").trim();
    const clearOpenAiApiKey = Boolean(req.body?.clearOpenAiApiKey);
    const urgentAlertPhone = String(req.body?.urgentAlertPhone || "").replace(/\D/g, "").slice(0, 20);
    const allowedModes = ["official_new_number", "official_existing_number", "qr_test"];
    const whatsappConnectionMode = allowedModes.includes(String(req.body?.whatsappConnectionMode))
      ? String(req.body.whatsappConnectionMode)
      : undefined;
    const whatsappDesiredPhone = String(req.body?.whatsappDesiredPhone || "").replace(/\D/g, "").slice(0, 20);
    const metaBusinessId = String(req.body?.metaBusinessId || "").trim();
    const metaWabaId = String(req.body?.metaWabaId || "").trim();
    const metaPhoneNumberId = String(req.body?.metaPhoneNumberId || "").trim();
    const metaAccessToken = String(req.body?.metaAccessToken || "").trim();

    if (whatsappConnectionMode) {
      const phoneOption = whatsappConnectionMode === "official_existing_number"
        ? "existing_number"
        : whatsappConnectionMode === "qr_test"
          ? "qr_test"
          : "new_number";

      await prisma.company.update({
        where: { id: companyId },
        data: {
          whatsappConnectionMode,
          whatsappPhoneOption: phoneOption,
          whatsappDesiredPhone,
          whatsappOfficialStatus: whatsappConnectionMode === "qr_test" ? "qr_test" : (metaPhoneNumberId && metaAccessToken ? "official_configured" : "pending_meta_setup"),
        },
      });

      if (whatsappConnectionMode !== "qr_test") {
        const existingOfficial = await prisma.whatsappInstance.findFirst({
          where: { companyId, provider: "meta_cloud_api" },
        });
        const officialData = {
          provider: "meta_cloud_api",
          connectionMode: whatsappConnectionMode,
          phoneNumber: whatsappDesiredPhone,
          status: metaPhoneNumberId && metaAccessToken ? "official_configured" : "pending_setup",
          ...(metaBusinessId ? { metaBusinessId } : {}),
          ...(metaWabaId ? { metaWabaId } : {}),
          ...(metaPhoneNumberId ? { metaPhoneNumberId } : {}),
          ...(metaAccessToken ? { metaAccessToken } : {}),
        };
        if (existingOfficial) {
          await prisma.whatsappInstance.update({ where: { id: existingOfficial.id }, data: officialData });
        } else {
          await prisma.whatsappInstance.create({
            data: {
              companyId,
              instanceName: "meta-" + companyId.slice(0, 12),
              ...officialData,
            },
          });
        }
      }
    }

    const config = await prisma.aiAssistantConfig.upsert({
      where: { companyId },
      create: {
        companyId,
        enabled: true,
        responseMode,
        ...(openAiApiKey ? { openAiApiKey } : {}),
        urgentAlertPhone,
      },
      update: {
        responseMode,
        urgentAlertPhone,
        ...(openAiApiKey ? { openAiApiKey } : {}),
        ...(clearOpenAiApiKey ? { openAiApiKey: null } : {}),
      },
    });

    return res.json({
      responseMode: config.responseMode,
      openAiKeyConfigured: Boolean(config.openAiApiKey),
      urgentAlertPhone: config.urgentAlertPhone || "",
      whatsappOfficialConfigured: Boolean(metaPhoneNumberId && metaAccessToken),
    });
  } catch (error) {
    console.error("Erro updateWhatsAppSettings:", error);
    return res.status(500).json({ error: "Erro ao salvar configuracoes" });
  }
}
