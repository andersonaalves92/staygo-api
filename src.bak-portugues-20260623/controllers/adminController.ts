import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signSessionToken } from "../lib/jwt";

const plans = new Set(["trial", "saas_only", "growth", "full_performance", "starter", "pro", "enterprise"]);
const statuses = new Set(["active", "paused", "canceled"]);
const subscriptionStatuses = new Set(["trial", "active", "overdue", "paused", "canceled"]);

function cents(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function temporaryPassword() {
  return `StayGo${Math.random().toString(36).slice(2, 8)}!${new Date().getFullYear()}`;
}

export async function listCompanies(_req: Request, res: Response) {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        payments: {
          orderBy: { dueDate: "desc" },
          take: 5,
        },
        whatsappInstances: {
          orderBy: { updatedAt: "desc" },
        },
        aiAssistantConfig: true,
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                isActive: true,
                isPlatformAdmin: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        _count: {
          select: {
            memberships: true,
            leads: true,
            conversations: true,
            whatsappInstances: true,
            messages: true,
            knowledgeItems: true,
          },
        },
      },
    });

    return res.json(companies);
  } catch (error) {
    console.error("Erro listCompanies:", error);
    return res.status(500).json({ error: "Erro ao listar empresas" });
  }
}

export async function getCompany(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" } },
        payments: { orderBy: { createdAt: "desc" }, take: 20 },
        memberships: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                isActive: true,
                isPlatformAdmin: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!company) {
      return res.status(404).json({ error: "Empresa nao encontrada" });
    }

    return res.json(company);
  } catch (error) {
    console.error("Erro getCompany:", error);
    return res.status(500).json({ error: "Erro ao buscar empresa" });
  }
}

export async function getBillingSummary(_req: Request, res: Response) {
  try {
    const [companies, subscriptions, payments] = await Promise.all([
      prisma.company.count(),
      prisma.subscription.findMany(),
      prisma.payment.findMany({
        where: {
          status: { in: ["received", "confirmed", "paid"] },
        },
      }),
    ]);

    const activeSubscriptions = subscriptions.filter((item) => item.status === "active");
    const overdueSubscriptions = subscriptions.filter((item) => item.status === "overdue");
    const monthlyRecurringCents = activeSubscriptions.reduce(
      (total, item) => total + item.amountCents,
      0
    );
    const paidCents = payments.reduce((total, item) => total + item.amountCents, 0);

    return res.json({
      companies,
      activeSubscriptions: activeSubscriptions.length,
      overdueSubscriptions: overdueSubscriptions.length,
      monthlyRecurringCents,
      paidCents,
    });
  } catch (error) {
    console.error("Erro getBillingSummary:", error);
    return res.status(500).json({ error: "Erro ao buscar faturamento" });
  }
}

export async function getPlatformSummary(_req: Request, res: Response) {
  try {
    const [
      companies,
      activeCompanies,
      messages,
      outboundAiMessages,
      connectedWhatsApps,
      aiEnabledCompanies,
      dueFollowUps,
    ] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { status: "active" } }),
      prisma.message.count(),
      prisma.message.count({
        where: {
          direction: "outbound",
          status: { in: ["sent", "suggested", "suggested_handoff"] },
        },
      }),
      prisma.whatsappInstance.count({ where: { status: "connected" } }),
      prisma.aiAssistantConfig.count({ where: { enabled: true } }),
      prisma.conversation.count({
        where: {
          followUpAt: { lte: new Date() },
          followUpSentAt: null,
          followUpStatus: { in: ["scheduled", "failed"] },
        },
      }),
    ]);

    return res.json({
      companies,
      activeCompanies,
      messages,
      outboundAiMessages,
      connectedWhatsApps,
      aiEnabledCompanies,
      dueFollowUps,
    });
  } catch (error) {
    console.error("Erro getPlatformSummary:", error);
    return res.status(500).json({ error: "Erro ao buscar resumo da plataforma" });
  }
}

export async function upsertSubscription(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const { plan, status, amount, nextDueDate, providerCustomerId, providerSubscriptionId } =
      req.body;

    if (plan && !plans.has(plan)) {
      return res.status(400).json({ error: "Plano invalido" });
    }

    if (status && !subscriptionStatuses.has(status)) {
      return res.status(400).json({ error: "Status de assinatura invalido" });
    }

    const existing = await prisma.subscription.findFirst({ where: { companyId } });

    const data = {
      ...(plan ? { plan } : {}),
      ...(status ? { status } : {}),
      ...(amount !== undefined ? { amountCents: cents(amount) } : {}),
      ...(nextDueDate ? { nextDueDate: new Date(nextDueDate) } : {}),
      ...(providerCustomerId ? { providerCustomerId } : {}),
      ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
    };

    const subscription = existing
      ? await prisma.subscription.update({ where: { id: existing.id }, data })
      : await prisma.subscription.create({
          data: {
            companyId,
            plan: plan || "trial",
            status: status || "trial",
            amountCents: amount !== undefined ? cents(amount) : 0,
            ...(nextDueDate ? { nextDueDate: new Date(nextDueDate) } : {}),
            ...(providerCustomerId ? { providerCustomerId } : {}),
            ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
          },
        });

    if (status === "active" || status === "trial") {
      await prisma.company.update({ where: { id: companyId }, data: { status: "active" } });
    }

    if (status === "overdue" || status === "paused") {
      await prisma.company.update({ where: { id: companyId }, data: { status: "paused" } });
    }

    if (status === "canceled") {
      await prisma.company.update({ where: { id: companyId }, data: { status: "canceled" } });
    }

    return res.json(subscription);
  } catch (error) {
    console.error("Erro upsertSubscription:", error);
    return res.status(500).json({ error: "Erro ao salvar assinatura" });
  }
}

export async function grantTrial(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const days = Math.max(1, Math.min(365, Number(req.body?.days || 30)));
    const now = new Date();
    const trialEndsAt = addDays(now, days);

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        plan: "trial",
        status: "active",
        trialStartsAt: now,
        trialEndsAt,
        manualAccessUntil: trialEndsAt,
        accessBlockedAt: null,
        accessBlockReason: null,
        subscriptions: {
          create: {
            plan: "trial",
            status: "trial",
            amountCents: 0,
            currentPeriodStart: now,
            currentPeriodEnd: trialEndsAt,
            nextDueDate: trialEndsAt,
          },
        },
      },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    return res.json(company);
  } catch (error) {
    console.error("Erro grantTrial:", error);
    return res.status(500).json({ error: "Erro ao liberar trial" });
  }
}

export async function blockCompany(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const reason = String(req.body?.reason || "Bloqueio manual pelo admin");

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        status: "paused",
        accessBlockedAt: new Date(),
        accessBlockReason: reason,
      },
    });

    return res.json(company);
  } catch (error) {
    console.error("Erro blockCompany:", error);
    return res.status(500).json({ error: "Erro ao bloquear empresa" });
  }
}

export async function unblockCompany(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const days = Number(req.body?.days || 0);
    const manualAccessUntil = days > 0 ? addDays(new Date(), Math.min(days, 365)) : null;

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        status: "active",
        accessBlockedAt: null,
        accessBlockReason: null,
        ...(manualAccessUntil ? { manualAccessUntil } : {}),
      },
    });

    return res.json(company);
  } catch (error) {
    console.error("Erro unblockCompany:", error);
    return res.status(500).json({ error: "Erro ao liberar empresa" });
  }
}

export async function createPayment(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const { status, amount, billingType, dueDate, paidAt, invoiceUrl, providerPaymentId } =
      req.body;

    const payment = await prisma.payment.create({
      data: {
        companyId,
        status: status || "pending",
        amountCents: cents(amount),
        ...(billingType ? { billingType } : {}),
        ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
        ...(paidAt ? { paidAt: new Date(paidAt) } : {}),
        ...(invoiceUrl ? { invoiceUrl } : {}),
        ...(providerPaymentId ? { providerPaymentId } : {}),
      },
    });

    return res.status(201).json(payment);
  } catch (error) {
    console.error("Erro createPayment:", error);
    return res.status(500).json({ error: "Erro ao registrar pagamento" });
  }
}

export async function updateCompany(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    const { name, plan, planName, status, trialEndsAt, manualAccessUntil, expiresAt, maxUsers, maxMessages } = req.body;

    if (plan && !plans.has(plan)) {
      return res.status(400).json({ error: "Plano invalido" });
    }

    if (status && !statuses.has(status)) {
      return res.status(400).json({ error: "Status invalido" });
    }

    const company = await prisma.company.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(plan ? { plan } : {}),
        ...(status ? { status } : {}),
        ...(planName !== undefined ? { planName: String(planName) } : {}),
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
        ...(maxUsers !== undefined ? { maxUsers: Math.max(1, Number(maxUsers) || 1) } : {}),
        ...(maxMessages !== undefined ? { maxMessages: Math.max(0, Number(maxMessages) || 0) } : {}),
        ...(trialEndsAt !== undefined
          ? { trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : null }
          : {}),
        ...(manualAccessUntil !== undefined
          ? { manualAccessUntil: manualAccessUntil ? new Date(manualAccessUntil) : null }
          : {}),
      },
    });

    return res.json(company);
  } catch (error) {
    console.error("Erro updateCompany:", error);
    return res.status(500).json({ error: "Erro ao atualizar empresa" });
  }
}

export async function updateCompanyUser(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const userId = String(req.params.userId);
    const { name, isActive, isPlatformAdmin, role } = req.body;

    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });

    if (!membership) {
      return res.status(404).json({ error: "Usuario nao pertence a empresa" });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name ? { name } : {}),
        ...(typeof isActive === "boolean" ? { isActive } : {}),
        ...(typeof isPlatformAdmin === "boolean" ? { isPlatformAdmin } : {}),
      },
    });

    if (role) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { role: String(role) },
      });
    }

    return getCompany(req, res);
  } catch (error) {
    console.error("Erro updateCompanyUser:", error);
    return res.status(500).json({ error: "Erro ao atualizar usuario" });
  }
}

export async function resetUserPassword(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const userId = String(req.params.userId);
    const requestedPassword = String(req.body?.password || "").trim();
    const newPassword = requestedPassword.length >= 8 ? requestedPassword : temporaryPassword();

    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });

    if (!membership) {
      return res.status(404).json({ error: "Usuario nao pertence a empresa" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, isActive: true },
    });

    return res.json({ ok: true, temporaryPassword: newPassword });
  } catch (error) {
    console.error("Erro resetUserPassword:", error);
    return res.status(500).json({ error: "Erro ao resetar senha" });
  }
}

export async function impersonateCompany(req: Request, res: Response) {
  try {
    const adminUserId = req.auth?.userId;
    const companyId = String(req.params.id);

    if (!adminUserId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const adminUser = await prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, tenantId: true, isPlatformAdmin: true },
    });

    if (!adminUser?.isPlatformAdmin) {
      return res.status(403).json({ error: "Acesso restrito" });
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });

    if (!company) {
      return res.status(404).json({ error: "Empresa nao encontrada" });
    }

    if (!company.supportAccessUntil || company.supportAccessUntil.getTime() < Date.now()) {
      return res.status(403).json({
        error: "Acesso de suporte nao autorizado. Peca para o cliente liberar acesso temporario em Privacidade / LGPD.",
      });
    }

    await prisma.supportAccessLog.create({
      data: {
        companyId,
        adminUserId: adminUser.id,
        action: "impersonate",
        reason: "Admin SaaS entrou com autorizacao temporaria de suporte",
        expiresAt: company.supportAccessUntil,
      },
    });

    const token = signSessionToken({
      userId: adminUser.id,
      tenantId: adminUser.tenantId,
      companyId,
      role: "owner",
      supportAccess: true,
    });

    res.cookie("session_token", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });

    return res.json({ ok: true, company });
  } catch (error) {
    console.error("Erro impersonateCompany:", error);
    return res.status(500).json({ error: "Erro ao entrar como empresa" });
  }
}
