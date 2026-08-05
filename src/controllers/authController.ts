import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { signSessionToken } from "../lib/jwt";
import { OAuth2Client } from "google-auth-library";

//
// 🔥 CRIA TENANT PADRÃO
//
async function createTenant(name: string) {
  return prisma.tenant.create({
    data: {
      name,
      domain: `${name.toLowerCase().replace(/\s+/g, "")}.staygobot.com`,
    },
  });
}

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  isActive?: boolean;
  isPlatformAdmin?: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    isActive: user.isActive,
    isPlatformAdmin: user.isPlatformAdmin ?? false,
  };
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function planSettings(planName?: string) {
  const plans: Record<string, { planName: string; maxUsers: number; maxMessages: number; expiresAt: Date }> = {
    trial: { planName: "Trial 30 dias", maxUsers: 1, maxMessages: 400, expiresAt: addDays(30) },
    saas_only: { planName: "SaaS Only", maxUsers: 3, maxMessages: 3000, expiresAt: addDays(30) },
    growth: { planName: "Growth", maxUsers: 6, maxMessages: 10000, expiresAt: addDays(30) },
    full_performance: { planName: "Full Performance", maxUsers: 12, maxMessages: 30000, expiresAt: addDays(30) },
  };

  return plans[planName || "trial"] ?? plans.trial;
}

async function googleClientId() {
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID;
  const integration = await prisma.googleIntegration.findFirst({ orderBy: { createdAt: "asc" } }).catch(() => null);
  return integration?.oauthClientId || "";
}

function companyHasAccess(company: {
  status: string;
  trialEndsAt?: Date | null;
  manualAccessUntil?: Date | null;
  accessBlockedAt?: Date | null;
}) {
  if (company.accessBlockedAt) return false;
  if (company.status === "active") return true;

  const now = Date.now();
  if (company.trialEndsAt && company.trialEndsAt.getTime() >= now) return true;
  if (company.manualAccessUntil && company.manualAccessUntil.getTime() >= now) return true;

  return false;
}

//
// 🔥 SEED OWNER (AGORA COM TENANT)
//
export async function seedOwner(_req: Request, res: Response) {
  try {
    const email = process.env.SEED_OWNER_EMAIL!;
    const password = process.env.SEED_OWNER_PASSWORD!;
    const name = process.env.SEED_OWNER_NAME!;

    const exists = await prisma.user.findUnique({
      where: { email },
    });

    if (exists) {
      return res.json({ ok: true, message: "Owner já existe" });
    }

    const tenant = await createTenant(name);

    const company = await prisma.company.create({
      data: {
        name: `Empresa de ${name}`,
      },
    });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        tenant: {
          connect: { id: tenant.id },
        },
        memberships: {
          create: {
            companyId: company.id,
            role: "owner",
          },
        },
      },
    });

    return res.json({
      ok: true,
      user: publicUser(user),
      company,
      tenant,
      role: "owner",
    });
  } catch (error) {
    console.error("Erro seedOwner:", error);
    return res.status(500).json({ error: "Erro ao criar owner" });
  }
}

//
// 🔥 LOGIN
//
export async function login(req: Request, res: Response) {
  try {
    const { email, password, companyId } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          include: {
            company: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);

    if (!valid) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    if (req.tenantId && user.tenantId !== req.tenantId) {
      return res.status(401).json({ error: "Credenciais invalidas" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "Usuario inativo" });
    }

    const activeMemberships = user.memberships.filter((membership) =>
      companyHasAccess(membership.company)
    );

    if (user.isPlatformAdmin && !companyId && activeMemberships.length > 1) {
      return res.status(409).json({
        error: "Selecione uma empresa",
        requiresCompanySelection: true,
        companies: activeMemberships.map((membership) => ({
          id: membership.companyId,
          name: membership.company.name,
          role: membership.role,
        })),
      });
    }

    const membership = companyId
      ? activeMemberships.find((item) => item.companyId === companyId)
      : activeMemberships[0];

    if (!membership) {
      return res.status(403).json({ error: "Sem empresa" });
    }

    const token = signSessionToken({
      userId: user.id,
      tenantId: user.tenantId,
      companyId: membership.companyId,
      role: membership.role,
    });

    res.cookie("session_token", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });

    return res.json({
      user: publicUser(user),
      company: membership.company,
      role: membership.role,
    });
  } catch (error) {
    console.error("Erro login:", error);
    return res.status(500).json({ error: "Erro no login" });
  }
}

//
// 🔥 REGISTER
//
function normalizeWhatsAppMode(value?: string) {
  const mode = String(value || "evolution_api");
  if (mode === "qr_test" || mode === "evolution_qr") return "evolution_api";
  const allowed = ["evolution_api", "official_new_number", "official_existing_number"];
  return allowed.includes(mode) ? mode : "evolution_api";
}

function whatsappPhoneOption(mode: string) {
  if (mode === "evolution_api") return "evolution_api";
  if (mode === "official_existing_number") return "existing_number";
  return "new_number";
}

export async function register(req: Request, res: Response) {
  try {
    const { name, email, password, companyName, planName, lgpdAccepted } = req.body;
    const whatsappConnectionMode = normalizeWhatsAppMode(req.body?.whatsappConnectionMode);
    const whatsappDesiredPhone = String(req.body?.whatsappDesiredPhone || "").replace(/\D/g, "").slice(0, 20);

    if (!lgpdAccepted) {
      return res.status(400).json({ error: "Aceite a politica de privacidade e o tratamento de dados para criar a conta." });
    }

    const exists = await prisma.user.findUnique({
      where: { email },
    });

    if (exists) {
      return res.status(400).json({ error: "Email já existe" });
    }

    const tenant = await createTenant(companyName);

    const selectedPlan = planSettings(planName);

    const company = await prisma.company.create({
      data: {
        name: companyName,
        status: "trial",
        trialEndsAt: selectedPlan.expiresAt,
        planName: selectedPlan.planName,
        expiresAt: selectedPlan.expiresAt,
        maxUsers: selectedPlan.maxUsers,
        maxMessages: selectedPlan.maxMessages,
        whatsappConnectionMode,
        whatsappPhoneOption: whatsappPhoneOption(whatsappConnectionMode),
        whatsappDesiredPhone,
        whatsappOfficialStatus: whatsappConnectionMode === "evolution_api" ? "evolution_pending_qr" : "pending_meta_setup",
        privacyPolicyAcceptedAt: new Date(),
        privacyPolicyVersion: "2026-06-12",
        dataProcessingBasis: "execucao_contrato",
      },
    });

    if (whatsappConnectionMode === "evolution_api") {
      await prisma.whatsappInstance.create({
        data: {
          companyId: company.id,
          instanceName: "evolution-" + company.id.slice(0, 12),
          provider: "evolution_qr",
          connectionMode: "evolution_api",
          phoneNumber: whatsappDesiredPhone,
          status: "disconnected",
        },
      });
    }

    if (whatsappConnectionMode !== "evolution_api") {
      await prisma.whatsappInstance.create({
        data: {
          companyId: company.id,
          instanceName: "meta-" + company.id.slice(0, 12),
          provider: "meta_cloud_api",
          connectionMode: whatsappConnectionMode,
          phoneNumber: whatsappDesiredPhone,
          status: "pending_setup",
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        tenant: {
          connect: { id: tenant.id },
        },
        memberships: {
          create: {
            companyId: company.id,
            role: "owner",
          },
        },
      },
    });

    const token = signSessionToken({
      userId: user.id,
      tenantId: tenant.id,
      companyId: company.id,
      role: "owner",
    });

    res.cookie("session_token", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });

    return res.json({
      user: publicUser(user),
      company,
      tenant,
      role: "owner",
    });
  } catch (error) {
    console.error("Erro register:", error);
    return res.status(500).json({ error: "Erro ao registrar" });
  }
}

export async function forgotPassword(req: Request, res: Response) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        console.log(`Solicitacao de recuperacao de senha para ${email}`);
      }
    }

    return res.json({
      ok: true,
      message: "Se o e-mail existir, enviaremos instrucoes para redefinir a senha.",
    });
  } catch (error) {
    console.error("Erro forgotPassword:", error);
    return res.status(500).json({ error: "Erro ao solicitar recuperacao" });
  }
}

export async function googleLoginConfig(_req: Request, res: Response) {
  const clientId = await googleClientId();
  return res.json({ enabled: Boolean(clientId), clientId });
}

export async function googleLogin(req: Request, res: Response) {
  try {
    const { credential, companyId } = req.body || {};
    const clientId = await googleClientId();

    if (!clientId) {
      return res.status(501).json({ error: "Google Login nao configurado" });
    }

    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken: String(credential || ""),
      audience: clientId,
    });

    const payload = ticket.getPayload();
    const email = payload?.email;

    if (!email) {
      return res.status(401).json({ error: "Conta Google invalida" });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { company: true } } },
    });

    if (!user || !user.isActive) {
      return res.status(403).json({ error: "Usuario nao encontrado ou inativo" });
    }

    const activeMemberships = user.memberships.filter((membership) =>
      companyHasAccess(membership.company)
    );

    if (user.isPlatformAdmin && !companyId && activeMemberships.length > 1) {
      return res.status(409).json({
        error: "Selecione uma empresa",
        requiresCompanySelection: true,
        companies: activeMemberships.map((membership) => ({
          id: membership.companyId,
          name: membership.company.name,
          role: membership.role,
        })),
      });
    }

    const membership = companyId
      ? activeMemberships.find((item) => item.companyId === companyId)
      : activeMemberships[0];

    if (!membership) {
      return res.status(403).json({ error: "Sem empresa ativa" });
    }

    const token = signSessionToken({
      userId: user.id,
      tenantId: user.tenantId,
      companyId: membership.companyId,
      role: membership.role,
    });

    res.cookie("session_token", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
    });

    return res.json({
      user: publicUser(user),
      company: membership.company,
      role: membership.role,
    });
  } catch (error) {
    console.error("Erro googleLogin:", error);
    return res.status(401).json({ error: "Erro ao entrar com Google" });
  }
}

//
// 🔥 ME
//
export async function me(req: Request, res: Response) {
  try {
    if (!req.auth) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
    });

    const company = await prisma.company.findUnique({
      where: { id: req.auth.companyId },
    });

    return res.json({
      user: user ? publicUser(user) : null,
      company,
      role: req.auth.role,
    });
  } catch (error) {
    console.error("Erro me:", error);
    return res.status(500).json({ error: "Erro ao buscar sessão" });
  }
}

//
// 🔥 LOGOUT
//
export async function logout(_req: Request, res: Response) {
  res.clearCookie("session_token", { path: "/" });
  return res.json({ ok: true });
}
