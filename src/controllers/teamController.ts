import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../lib/prisma";

const roles = new Set(["owner", "admin", "agent"]);

export async function listTeam(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    const team = await prisma.membership.findMany({
      where: { companyId },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return res.json(
      team.map((member) => ({
        id: member.id,
        role: member.role,
        createdAt: member.createdAt,
        user: {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          avatarUrl: member.user.avatarUrl,
          isActive: member.user.isActive,
        },
      }))
    );
  } catch (error) {
    console.error("Erro em listTeam:", error);
    return res.status(500).json({ error: "Erro ao listar equipe" });
  }
}

export async function listInvitations(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;

    if (!companyId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const invitations = await prisma.teamInvitation.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });

    return res.json(invitations);
  } catch (error) {
    console.error("Erro em listInvitations:", error);
    return res.status(500).json({ error: "Erro ao listar convites" });
  }
}

export async function createInvitation(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const currentRole = req.auth?.role;
    const invitedByUserId = req.auth?.userId;

    if (!companyId || !currentRole || !invitedByUserId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    if (currentRole !== "owner" && currentRole !== "admin") {
      return res.status(403).json({ error: "Sem permissao" });
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "agent");

    if (!email || !roles.has(role)) {
      return res.status(400).json({ error: "Email ou papel invalido" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await prisma.teamInvitation.create({
      data: { companyId, email, role, token, invitedByUserId, expiresAt },
      include: { company: true },
    });

    const baseUrl = process.env.APP_URL || "https://homolog.staygobot.com";

    return res.status(201).json({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      inviteUrl: `${baseUrl}/invite/${invitation.token}`,
      company: invitation.company,
    });
  } catch (error) {
    console.error("Erro em createInvitation:", error);
    return res.status(500).json({ error: "Erro ao criar convite" });
  }
}

export async function getInvitation(req: Request, res: Response) {
  try {
    const token = String(req.params.token);
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
      return res.status(404).json({ error: "Convite invalido ou expirado" });
    }

    const company = await prisma.company.findUnique({
      where: { id: invitation.companyId },
    });

    return res.json({
      email: invitation.email,
      role: invitation.role,
      company,
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    console.error("Erro em getInvitation:", error);
    return res.status(500).json({ error: "Erro ao buscar convite" });
  }
}

export async function acceptInvitation(req: Request, res: Response) {
  try {
    const token = String(req.params.token);
    const invitation = await prisma.teamInvitation.findUnique({
      where: { token },
    });

    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
      return res.status(404).json({ error: "Convite invalido ou expirado" });
    }

    const { name, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: "Nome e senha sao obrigatorios" });
    }

    const tenant = await prisma.tenant.findFirst({
      where: {
        users: {
          some: {
            memberships: { some: { companyId: invitation.companyId } },
          },
        },
      },
    });

    if (!tenant) {
      return res.status(400).json({ error: "Tenant da empresa nao encontrado" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.upsert({
      where: { email: invitation.email },
      update: { name, passwordHash, isActive: true, tenantId: tenant.id },
      create: {
        name,
        email: invitation.email,
        passwordHash,
        isActive: true,
        tenantId: tenant.id,
      },
    });

    await prisma.membership.upsert({
      where: {
        userId_companyId: {
          userId: user.id,
          companyId: invitation.companyId,
        },
      },
      update: { role: invitation.role },
      create: {
        userId: user.id,
        companyId: invitation.companyId,
        role: invitation.role,
      },
    });

    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    const company = await prisma.company.findUnique({
      where: { id: invitation.companyId },
    });

    return res.json({ ok: true, company });
  } catch (error) {
    console.error("Erro em acceptInvitation:", error);
    return res.status(500).json({ error: "Erro ao aceitar convite" });
  }
}

export async function createTeamMember(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const currentRole = req.auth?.role;
    const tenantId = (req as any).tenantId; // 🔥 importante

    if (!companyId || !currentRole || !tenantId) {
      return res.status(401).json({ error: "Não autenticado" });
    }

    if (currentRole !== "owner" && currentRole !== "admin") {
      return res.status(403).json({ error: "Sem permissão" });
    }

    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        error: "name, email, password e role são obrigatórios",
      });
    }

    if (!roles.has(role)) {
      return res.status(400).json({
        error: "role inválido",
      });
    }

    let user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10);

      user = await prisma.user.create({
        data: {
          name,
          email,
          passwordHash,
          isActive: true,

          // 🔥 CORREÇÃO PRINCIPAL
          tenant: {
            connect: { id: tenantId },
          },
        },
      });
    }

    const existingMembership = await prisma.membership.findFirst({
      where: {
        companyId,
        userId: user.id,
      },
    });

    if (existingMembership) {
      return res.status(400).json({
        error: "Usuário já pertence a esta empresa",
      });
    }

    const membership = await prisma.membership.create({
      data: {
        companyId,
        userId: user.id,
        role,
      },
      include: {
        user: true,
      },
    });

    return res.status(201).json({
      id: membership.id,
      role: membership.role,
      createdAt: membership.createdAt,
      user: {
        id: membership.user.id,
        name: membership.user.name,
        email: membership.user.email,
        avatarUrl: membership.user.avatarUrl,
        isActive: membership.user.isActive,
      },
    });
  } catch (error) {
    console.error("Erro em createTeamMember:", error);
    return res.status(500).json({ error: "Erro ao criar usuário da equipe" });
  }
}


export async function getSupportAccess(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    if (!companyId) return res.status(401).json({ error: "Nao autenticado" });

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { supportAccessUntil: true, supportAccessReason: true, supportAccessGrantedByUserId: true, privacyPolicyAcceptedAt: true, privacyPolicyVersion: true, dataProcessingBasis: true },
    });

    const logs = await prisma.supportAccessLog.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return res.json({
      supportAccessUntil: company?.supportAccessUntil || null,
      supportAccessReason: company?.supportAccessReason || "",
      privacyPolicyAcceptedAt: company?.privacyPolicyAcceptedAt || null,
      privacyPolicyVersion: company?.privacyPolicyVersion || "2026-06-12",
      dataProcessingBasis: company?.dataProcessingBasis || "execucao_contrato",
      active: Boolean(company?.supportAccessUntil && company.supportAccessUntil.getTime() > Date.now()),
      logs,
    });
  } catch (error) {
    console.error("Erro getSupportAccess:", error);
    return res.status(500).json({ error: "Erro ao buscar acesso de suporte" });
  }
}

export async function grantSupportAccess(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const userId = req.auth?.userId;
    if (!companyId || !userId) return res.status(401).json({ error: "Nao autenticado" });

    const hours = Math.max(1, Math.min(72, Number(req.body?.hours || 24)));
    const reason = String(req.body?.reason || "Suporte técnico autorizado pelo cliente").slice(0, 240);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const company = await prisma.company.update({
      where: { id: companyId },
      data: {
        supportAccessUntil: expiresAt,
        supportAccessReason: reason,
        supportAccessGrantedByUserId: userId,
      },
      select: { supportAccessUntil: true, supportAccessReason: true },
    });

    await prisma.supportAccessLog.create({
      data: { companyId, grantedByUserId: userId, action: "grant", reason, expiresAt },
    });

    return res.json({ ok: true, active: true, ...company });
  } catch (error) {
    console.error("Erro grantSupportAccess:", error);
    return res.status(500).json({ error: "Erro ao autorizar suporte" });
  }
}

export async function revokeSupportAccess(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    const userId = req.auth?.userId;
    if (!companyId || !userId) return res.status(401).json({ error: "Nao autenticado" });

    await prisma.company.update({
      where: { id: companyId },
      data: { supportAccessUntil: null, supportAccessReason: "", supportAccessGrantedByUserId: null },
    });

    await prisma.supportAccessLog.create({
      data: { companyId, grantedByUserId: userId, action: "revoke", reason: "Acesso de suporte revogado pelo cliente" },
    });

    return res.json({ ok: true, active: false, supportAccessUntil: null });
  } catch (error) {
    console.error("Erro revokeSupportAccess:", error);
    return res.status(500).json({ error: "Erro ao revogar suporte" });
  }
}


export async function getPrivacyReport(req: Request, res: Response) {
  try {
    const companyId = req.auth?.companyId;
    if (!companyId) return res.status(401).json({ error: "Nao autenticado" });

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        planName: true,
        status: true,
        expiresAt: true,
        maxUsers: true,
        maxMessages: true,
        whatsappConnectionMode: true,
        whatsappPhoneOption: true,
        whatsappOfficialStatus: true,
        supportAccessUntil: true,
        supportAccessReason: true,
        privacyPolicyAcceptedAt: true,
        privacyPolicyVersion: true,
        dataProcessingBasis: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!company) return res.status(404).json({ error: "Empresa nao encontrada" });

    const [memberships, leads, conversations, messages, knowledgeItems, aiAssistantConfig, supportLogs] = await Promise.all([
      prisma.membership.count({ where: { companyId } }),
      prisma.lead.count({ where: { companyId } }),
      prisma.conversation.count({ where: { companyId } }),
      prisma.message.count({ where: { companyId } }),
      prisma.knowledgeItem.count({ where: { companyId } }),
      prisma.aiAssistantConfig.findUnique({
        where: { companyId },
        select: { enabled: true, responseMode: true, urgentAlertPhone: true, maxContextMessages: true, updatedAt: true },
      }),
      prisma.supportAccessLog.findMany({
        where: { companyId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, action: true, reason: true, expiresAt: true, createdAt: true },
      }),
    ]);

    return res.json({
      generatedAt: new Date(),
      version: "lgpd-report-2026-06-12",
      company,
      counts: { memberships, leads, conversations, messages, knowledgeItems },
      aiAssistantConfig,
      supportAccess: {
        active: Boolean(company.supportAccessUntil && company.supportAccessUntil.getTime() > Date.now()),
        until: company.supportAccessUntil,
        reason: company.supportAccessReason,
      },
      supportLogs,
      notes: [
        "Este relatorio nao inclui conteúdo de conversas, mensagens, nomes de leads ou dados sensíveis.",
        "O objetivo e auditoria operacional, prestacao de contas e governanca de privacidade.",
      ],
    });
  } catch (error) {
    console.error("Erro getPrivacyReport:", error);
    return res.status(500).json({ error: "Erro ao gerar relatorio LGPD" });
  }
}
