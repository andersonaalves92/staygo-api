import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import os from "os";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { promisify } from "util";
import { prisma } from "../lib/prisma";
import { signSessionToken } from "../lib/jwt";

const execFileAsync = promisify(execFile);
const plans = new Set(["trial", "saas_only", "growth", "full_performance", "starter", "pro", "enterprise"]);
const statuses = new Set(["active", "paused", "canceled"]);
const subscriptionStatuses = new Set(["trial", "active", "overdue", "paused", "canceled"]);

function clean(value: any, fallback = "") { return String(value ?? fallback).trim(); }
function onlyDigits(value: any) { return String(value || "").replace(/\D/g, ""); }
function moneyFromCents(value: number) { return Number(value || 0) / 100; }
function slugify(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "empresa";
}
async function ensureCompanySlug(companyId: string, name?: string | null) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, publicSlug: true } });
  if (!company) return "";
  if (company.publicSlug) return company.publicSlug;
  const base = slugify(name || company.name);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : base + "-" + (i + 1);
    const exists = await prisma.company.findFirst({ where: { publicSlug: candidate, NOT: { id: companyId } }, select: { id: true } });
    if (!exists) {
      await prisma.company.update({ where: { id: companyId }, data: { publicSlug: candidate } });
      return candidate;
    }
  }
  const fallback = base + "-" + companyId.slice(-6);
  await prisma.company.update({ where: { id: companyId }, data: { publicSlug: fallback } });
  return fallback;
}

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

async function logOperation(companyId: string, data: { category: string; action: string; title: string; details?: string; status?: string; metadata?: any; createdBy?: string }) {
  try {
    return await prisma.operationLog.create({
      data: {
        companyId,
        category: data.category,
        action: data.action,
        title: data.title,
        details: data.details || "",
        status: data.status || "done",
        metadata: data.metadata || undefined,
        createdBy: data.createdBy || "StayGoBot",
      },
    });
  } catch (error) {
    console.error("Erro logOperation:", error);
    return null;
  }
}

function parseNginxDate(value: string) {
  const match = value.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!match) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const [, day, mon, year, hour, minute, second, offset] = match;
  const iso = `${year}-${months[mon] || "01"}-${day}T${hour}:${minute}:${second}${offset.slice(0, 3)}:${offset.slice(3)}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseAccessLine(line: string) {
  const match = line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]+?) HTTP\/[\d.]+" (\d+) (\S+) "([^"]*)" "([^"]*)"/);
  if (!match) return null;
  const [, ip, rawDate, method, url, rawStatus, bytes, referrer, userAgent] = match;
  const parsedAt = parseNginxDate(rawDate);
  const bot = /bot|crawler|spider|adsbot|gptbot|googlebot|bingpreview|facebookexternalhit/i.test(userAgent);
  return {
    ip,
    method,
    url,
    status: Number(rawStatus),
    bytes: bytes === "-" ? 0 : Number(bytes),
    referrer,
    userAgent,
    bot,
    parsedAt,
    rawDate,
  };
}

async function readAccessLogs() {
  const paths = ["/var/log/nginx/access.log", "/var/log/nginx/access.log.1"];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return "";
      }
    })
  );
  return chunks.join("\n").split("\n").filter(Boolean);
}

async function safeExec(command: string, args: string[] = []) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: "", error: error instanceof Error ? error.message : "Erro ao executar comando" };
  }
}

async function diskUsage() {
  const result = await safeExec("df", ["-h", "/"]);
  if (!result.ok) return null;
  const [, line] = result.stdout.trim().split("\n");
  const parts = line?.split(/\s+/) || [];
  return parts.length >= 6 ? { filesystem: parts[0], size: parts[1], used: parts[2], available: parts[3], usePercent: parts[4], mount: parts[5] } : null;
}

async function pm2Processes() {
  const result = await safeExec("pm2", ["jlist"]);
  if (!result.ok) return [];
  try {
    return JSON.parse(result.stdout).map((process: any) => ({
      name: process.name,
      pid: process.pid,
      status: process.pm2_env?.status,
      restarts: process.pm2_env?.restart_time || 0,
      uptime: process.pm2_env?.pm_uptime ? new Date(process.pm2_env.pm_uptime).toISOString() : null,
      memoryMb: process.monit?.memory ? Math.round(process.monit.memory / 1024 / 1024) : 0,
      cpu: process.monit?.cpu || 0,
    }));
  } catch {
    return [];
  }
}

async function dockerContainers() {
  const result = await safeExec("docker", ["ps", "--format", "{{.Names}}|{{.Status}}|{{.Ports}}"]);
  if (!result.ok) return [];
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, status, ports] = line.split("|");
    return { name, status, ports };
  });
}

function startOfCurrentMonth() {
  const now = new Date();
  const brazilNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(brazilNow.getUTCFullYear(), brazilNow.getUTCMonth(), 1, 3, 0, 0, 0));
}

async function buildLeadIntelligence(companyId: string) {
  const since = startOfCurrentMonth();
  const leads = await prisma.lead.findMany({ where: { companyId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
  const total = leads.length;
  const qualified = leads.filter((l: any) => ["qualificado", "consulta_marcada", "contratado"].includes(l.qualificationStatus)).length;
  const contracted = leads.filter((l: any) => l.qualificationStatus === "contratado" || l.stage === "contratado").length;
  const lost = leads.filter((l: any) => ["perdido", "ruim"].includes(l.qualificationStatus) || l.stage === "perdido").length;
  const urgent = leads.filter((l: any) => String(l.urgency || "").toLowerCase().includes("urg") || l.stage === "urgente").length;
  const closedRevenue = leads.reduce((sum: number, lead: any) => sum + Number(lead.closedValue || 0), 0);
  const byCampaign = new Map<string, any>();
  const byLoss = new Map<string, number>();
  const byKeyword = new Map<string, any>();
  for (const lead of leads as any[]) {
    const campaign = lead.campaign || lead.source || "sem origem";
    const keyword = lead.keyword || "sem termo";
    const loss = lead.lossReason || "sem motivo";
    const c = byCampaign.get(campaign) || { name: campaign, leads: 0, qualified: 0, contracted: 0, lost: 0, revenue: 0 };
    c.leads++;
    if (["qualificado", "consulta_marcada", "contratado"].includes(lead.qualificationStatus)) c.qualified++;
    if (lead.qualificationStatus === "contratado" || lead.stage === "contratado") c.contracted++;
    if (["perdido", "ruim"].includes(lead.qualificationStatus) || lead.stage === "perdido") c.lost++;
    c.revenue += Number(lead.closedValue || 0);
    byCampaign.set(campaign, c);
    const k = byKeyword.get(keyword) || { name: keyword, leads: 0, qualified: 0, contracted: 0, lost: 0 };
    k.leads++;
    if (["qualificado", "consulta_marcada", "contratado"].includes(lead.qualificationStatus)) k.qualified++;
    if (lead.qualificationStatus === "contratado" || lead.stage === "contratado") k.contracted++;
    if (["perdido", "ruim"].includes(lead.qualificationStatus) || lead.stage === "perdido") k.lost++;
    byKeyword.set(keyword, k);
    if (["perdido", "ruim"].includes(lead.qualificationStatus) || lead.stage === "perdido") byLoss.set(loss, (byLoss.get(loss) || 0) + 1);
  }
  const campaigns = Array.from(byCampaign.values()).sort((a, b) => b.contracted - a.contracted || b.qualified - a.qualified || b.leads - a.leads);
  const keywords = Array.from(byKeyword.values()).sort((a, b) => b.lost - a.lost || b.leads - a.leads).slice(0, 12);
  const lossReasons = Array.from(byLoss.entries()).map(([reason, total]) => ({ reason, total })).sort((a, b) => b.total - a.total);
  const recommendations: string[] = [];
  if (total && qualified / total < 0.35) recommendations.push("A taxa de qualificacao esta baixa. Revise termos de busca, promessa da landing page e perguntas do formulario.");
  if (lossReasons[0]?.reason && lossReasons[0].reason !== "sem motivo") recommendations.push("Principal motivo de perda: " + lossReasons[0].reason + ". Use isso para negativar termos e ajustar a oferta.");
  if (campaigns[0]?.contracted > 0) recommendations.push("Campanha com melhor sinal de contrato: " + campaigns[0].name + ". Priorize orcamento e variacoes proximas.");
  if (!recommendations.length) recommendations.push("Ainda faltam dados de qualificacao. Marque leads como qualificado, perdido ou contratado para o algoritmo comercial aprender.");
  return { period: "mes atual", periodStart: since, total, qualified, contracted, lost, urgent, closedRevenue, qualificationRate: total ? Math.round((qualified / total) * 100) : 0, contractRate: total ? Math.round((contracted / total) * 100) : 0, campaigns, keywords, lossReasons, recommendations };
}

function buildNextActions(intel: any, workspace: any, landingValidation: any, billing: any) {
  const actions: Array<{ priority: string; title: string; details: string; cta: string; href: string }> = [];
  if (!workspace?.finalUrl) actions.push({ priority: "alta", title: "Configurar URL final da landing", details: "Sem URL final por empresa, o Google e os relatórios ficam genéricos.", cta: "Abrir Ads", href: "/ads" });
  if (!workspace?.googleCampaignId && !workspace?.googleCampaignName) actions.push({ priority: "alta", title: "Vincular campanha Google", details: "Informe ID ou nome da campanha para separar métricas por empresa.", cta: "Vincular campanha", href: "/ads" });
  if (landingValidation && !landingValidation.ok) actions.push({ priority: "alta", title: "Corrigir landing antes de escalar Ads", details: landingValidation.issues.slice(0, 2).join(" | "), cta: "Ver Monitor", href: "/admin/monitor" });
  if (intel.total > 0 && intel.qualificationRate < 30) actions.push({ priority: "media", title: "Melhorar qualidade dos leads", details: "Taxa de qualificação abaixo de 30%. Revise termos de busca e promessa da landing.", cta: "Abrir Google", href: "/ads-analytics" });
  if (intel.urgent > 0) actions.push({ priority: "alta", title: "Responder leads urgentes", details: `${intel.urgent} lead(s) com urgência jurídica neste mês.`, cta: "Chat Laura", href: "/conversations?alertOnly=1" });
  if (billing?.overdue) actions.push({ priority: "media", title: "Regularizar pagamento", details: "Empresa com assinatura vencida ou pagamento pendente.", cta: "Admin SaaS", href: "/admin" });
  if (!actions.length) actions.push({ priority: "ok", title: "Operação saudável", details: "Siga marcando contrato, perdido e consulta para alimentar os relatórios.", cta: "Gerar relatório", href: "/relatorios" });
  return actions.slice(0, 6);
}

async function validateLandingForCompany(companyId: string) {
  const config = await prisma.adsWorkspaceConfig.findUnique({ where: { companyId } });
  const issues: string[] = [];
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  const url = config?.finalUrl || "";
  checks.push({ label: "URL final cadastrada", ok: Boolean(url), detail: url || "Sem URL final" });
  checks.push({ label: "Campanha Google vinculada", ok: Boolean(config?.googleCampaignId || config?.googleCampaignName), detail: config?.googleCampaignId || config?.googleCampaignName || "Sem filtro Google" });
  if (!url) issues.push("URL final da landing não foi cadastrada.");
  if (!config?.googleCampaignId && !config?.googleCampaignName) issues.push("Campanha Google não vinculada à empresa.");
  if (url) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      const html = await response.text();
      const hasStayGo = /staygobot|public\/capture|api\/public\/capture/i.test(html);
      const hasForm = /<form|input|textarea|button/i.test(html);
      const hasGa = /gtag|googletagmanager|G-[A-Z0-9]+/i.test(html);
      checks.push({ label: "Landing acessível", ok: response.ok, detail: String(response.status) });
      checks.push({ label: "Formulário/campos detectados", ok: hasForm, detail: hasForm ? "Encontrado" : "Não encontrei form/campos no HTML" });
      checks.push({ label: "Integração StayGoBot", ok: hasStayGo, detail: hasStayGo ? "Snippet/endpoint encontrado" : "Snippet não encontrado" });
      checks.push({ label: "GA4/GTM", ok: hasGa, detail: hasGa ? "Tag encontrada" : "Tag não encontrada" });
      if (!response.ok) issues.push("Landing não retornou status HTTP saudável.");
      if (!hasForm) issues.push("Landing sem formulário ou campos detectáveis.");
      if (!hasStayGo) issues.push("Landing sem integração visível com endpoint StayGoBot.");
      if (!hasGa) issues.push("Landing sem tag GA4/GTM detectada.");
    } catch (error) {
      checks.push({ label: "Landing acessível", ok: false, detail: error instanceof Error ? error.message : "Erro ao acessar" });
      issues.push("Não foi possível acessar a landing.");
    }
  }
  return { ok: issues.length === 0, url, checks, issues };
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
            operationLogs: true,
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

export async function getLandingMonitor(req: Request, res: Response) {
  try {
    const slug = String(req.query.slug || "kelven-criminalista").trim().toLowerCase();
    const hours = Math.max(1, Math.min(168, Number(req.query.hours || 24)));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const company = await prisma.company.findFirst({
      where: {
        OR: [
          { publicSlug: slug },
          { id: slug },
        ],
      },
      select: { id: true, name: true, publicSlug: true, status: true, leadWhatsappNumber: true, adsWorkspaceConfig: true },
    });

    if (!company) {
      return res.status(404).json({ error: "Empresa nao encontrada para monitoramento." });
    }

    const routeHints = [
      `/advogado-criminalista-brasilia-24h`,
      `/capturar/${company.publicSlug}`,
      `/public/capture/${company.publicSlug}`,
      `/api/public/capture/${company.publicSlug}`,
    ];

    const lines = await readAccessLogs();
    const events = lines
      .map(parseAccessLine)
      .filter((event): event is NonNullable<ReturnType<typeof parseAccessLine>> => Boolean(event))
      .filter((event) => event.parsedAt && event.parsedAt >= since)
      .filter((event) => routeHints.some((hint) => event.url.includes(hint)))
      .map((event) => {
        const type = event.method === "POST"
          ? "lead_post"
          : event.url.includes("/api/public/capture/") || event.url.includes("/public/capture/")
            ? "public_config"
            : "landing_view";
        return {
          type,
          ip: event.ip,
          method: event.method,
          url: event.url,
          status: event.status,
          referrer: event.referrer,
          userAgent: event.userAgent,
          bot: event.bot,
          at: event.parsedAt?.toISOString(),
        };
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const leads = await prisma.lead.findMany({
      where: { companyId: company.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        contactName: true,
        phone: true,
        source: true,
        campaign: true,
        keyword: true,
        capturedFrom: true,
        stage: true,
        status: true,
        leadScore: true,
        createdAt: true,
      },
    });

    const uniqueHumanIps = new Set(events.filter((event) => !event.bot).map((event) => event.ip));
    const uniqueBotIps = new Set(events.filter((event) => event.bot).map((event) => event.ip));
    const leadPosts = events.filter((event) => event.type === "lead_post");
    const humanViews = events.filter((event) => event.type === "landing_view" && !event.bot);
    const botViews = events.filter((event) => event.bot);
    const adsBotViews = events.filter((event) => /AdsBot-Google/i.test(event.userAgent));

    return res.json({
      company,
      adsWorkspace: company.adsWorkspaceConfig,
      landingUrl: company.adsWorkspaceConfig?.finalUrl || "https://www.kelvencriminalista.com.br/advogado-criminalista-brasilia-24h/",
      windowHours: hours,
      generatedAt: new Date().toISOString(),
      summary: {
        events: events.length,
        landingViews: events.filter((event) => event.type === "landing_view").length,
        publicConfigHits: events.filter((event) => event.type === "public_config").length,
        leadPosts: leadPosts.length,
        humanViews: humanViews.length,
        botViews: botViews.length,
        adsBotViews: adsBotViews.length,
        uniqueHumanIps: uniqueHumanIps.size,
        uniqueBotIps: uniqueBotIps.size,
        leadsCreated: leads.length,
      },
      latestHumanEvent: events.find((event) => !event.bot) || null,
      latestLeadPost: leadPosts[0] || null,
      latestLead: leads[0] || null,
      events: events.slice(0, 80),
      leads,
    });
  } catch (error) {
    console.error("Erro getLandingMonitor:", error);
    return res.status(500).json({ error: "Erro ao monitorar landing." });
  }
}

export async function getServerMonitor(_req: Request, res: Response) {
  try {
    const [disk, processes, containers] = await Promise.all([
      diskUsage(),
      pm2Processes(),
      dockerContainers(),
    ]);
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    return res.json({
      generatedAt: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: Math.round(os.uptime()),
        loadAverage: os.loadavg(),
        cpuCores: os.cpus().length,
        memory: {
          totalMb: Math.round(totalMemory / 1024 / 1024),
          usedMb: Math.round(usedMemory / 1024 / 1024),
          freeMb: Math.round(freeMemory / 1024 / 1024),
          usedPercent: Math.round((usedMemory / totalMemory) * 100),
        },
        disk,
      },
      services: [
        { name: "API StayGoBot", status: "online", detail: "Processo Express respondeu este endpoint." },
        ...processes.map((process) => ({
          name: `PM2 · ${process.name}`,
          status: process.status === "online" ? "online" : "attention",
          detail: `${process.memoryMb} MB · CPU ${process.cpu}% · reinícios ${process.restarts}`,
        })),
        ...containers.map((container) => ({
          name: `Docker · ${container.name}`,
          status: /Up/i.test(container.status || "") ? "online" : "attention",
          detail: container.status || container.ports || "sem status",
        })),
      ],
      pm2: processes,
      docker: containers,
    });
  } catch (error) {
    console.error("Erro getServerMonitor:", error);
    return res.status(500).json({ error: "Erro ao monitorar servidor." });
  }
}


export async function getCompanyAdsWorkspace(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, publicSlug: true, leadWhatsappNumber: true, leadReportEmail: true } });
    if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
    const publicSlug = await ensureCompanySlug(company.id, company.name);
    const config = await prisma.adsWorkspaceConfig.findUnique({ where: { companyId } });
    return res.json({
      company: { ...company, publicSlug },
      capture: { publicLeadUrl: "/capturar/" + publicSlug, apiEndpoint: "/api/public/capture/" + publicSlug + "/leads" },
      config: config ? { ...config, dailyBudget: moneyFromCents(config.dailyBudgetCents) } : null,
    });
  } catch (error) {
    console.error("Erro getCompanyAdsWorkspace:", error);
    return res.status(500).json({ error: "Erro ao carregar configuracao de Ads da empresa." });
  }
}

export async function saveCompanyAdsWorkspace(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const body = req.body || {};
    const current = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
    if (!current) return res.status(404).json({ error: "Empresa nao encontrada." });
    let publicSlug = clean(body.publicSlug);
    if (!publicSlug) publicSlug = await ensureCompanySlug(companyId, current.name);
    publicSlug = slugify(publicSlug);
    const exists = await prisma.company.findFirst({ where: { publicSlug, NOT: { id: companyId } }, select: { id: true } });
    if (exists) return res.status(409).json({ error: "Este slug publico ja esta em uso." });
    await prisma.company.update({ where: { id: companyId }, data: { publicSlug, leadWhatsappNumber: onlyDigits(body.leadWhatsappNumber), leadReportEmail: clean(body.leadReportEmail) } });
    const config = await prisma.adsWorkspaceConfig.upsert({
      where: { companyId },
      update: {
        finalUrl: clean(body.finalUrl),
        campaignName: clean(body.campaignName),
        googleCampaignId: onlyDigits(body.googleCampaignId),
        googleCampaignName: clean(body.googleCampaignName),
        keywordTemplate: clean(body.keywordTemplate || body.keyword || "{keyword}"),
        dailyBudgetCents: cents(String(body.dailyBudget || "0").replace(",", ".")),
        adTitle: clean(body.adTitle),
        adDescription: clean(body.adDescription),
        adCallout: clean(body.adCallout),
        manualWhatsappLink: clean(body.manualWhatsappLink),
        googleApplyStatus: "saved_in_staygobot",
        googleApplyNote: "Configuracao salva no StayGoBot. Aplicacao direta no Google Ads depende de permissao de escrita da Google Ads API.",
      },
      create: {
        companyId,
        finalUrl: clean(body.finalUrl),
        campaignName: clean(body.campaignName),
        googleCampaignId: onlyDigits(body.googleCampaignId),
        googleCampaignName: clean(body.googleCampaignName),
        keywordTemplate: clean(body.keywordTemplate || body.keyword || "{keyword}"),
        dailyBudgetCents: cents(String(body.dailyBudget || "0").replace(",", ".")),
        adTitle: clean(body.adTitle),
        adDescription: clean(body.adDescription),
        adCallout: clean(body.adCallout),
        manualWhatsappLink: clean(body.manualWhatsappLink),
        googleApplyStatus: "saved_in_staygobot",
        googleApplyNote: "Configuracao salva no StayGoBot. Aplicacao direta no Google Ads depende de permissao de escrita da Google Ads API.",
      },
    });
    await logOperation(companyId, {
      category: "ads",
      action: "ads_workspace_saved",
      title: "Configuração de Ads salva",
      details: `URL: ${config.finalUrl || "sem URL"} | Campanha Google: ${config.googleCampaignId || config.googleCampaignName || "sem vínculo"}`,
      metadata: { finalUrl: config.finalUrl, campaignName: config.campaignName, googleCampaignId: config.googleCampaignId, googleCampaignName: config.googleCampaignName },
      createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin",
    });
    return res.json({ ok: true, config: { ...config, dailyBudget: moneyFromCents(config.dailyBudgetCents) } });
  } catch (error) {
    console.error("Erro saveCompanyAdsWorkspace:", error);
    return res.status(500).json({ error: "Erro ao salvar configuracao de Ads da empresa." });
  }
}

export async function getCompanyLeadIntelligence(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
    return res.json(await buildLeadIntelligence(companyId));
  } catch (error) {
    console.error("Erro getCompanyLeadIntelligence:", error);
    return res.status(500).json({ error: "Erro ao gerar inteligencia da empresa." });
  }
}

export async function getCompanyOperations(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
        payments: { orderBy: { createdAt: "desc" }, take: 3 },
        adsWorkspaceConfig: true,
      },
    });
    if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
    const [intel, landingValidation, logs] = await Promise.all([
      buildLeadIntelligence(companyId),
      validateLandingForCompany(companyId),
      prisma.operationLog.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    const subscription = company.subscriptions[0];
    const billing = {
      overdue: ["overdue", "paused", "canceled"].includes(subscription?.status || "") || Boolean(company.accessBlockedAt),
      status: subscription?.status || company.status,
      amountCents: subscription?.amountCents || 0,
      nextDueDate: subscription?.nextDueDate || company.expiresAt || company.trialEndsAt,
      paidCents: company.payments.filter((payment) => payment.status === "paid").reduce((sum, payment) => sum + payment.amountCents, 0),
    };
    const nextActions = buildNextActions(intel, company.adsWorkspaceConfig, landingValidation, billing);
    return res.json({ company: { id: company.id, name: company.name, publicSlug: company.publicSlug, status: company.status, plan: company.plan, planName: company.planName }, intel, landingValidation, billing, nextActions, logs });
  } catch (error) {
    console.error("Erro getCompanyOperations:", error);
    return res.status(500).json({ error: "Erro ao carregar operação da empresa." });
  }
}

export async function getCompanyOperationLogs(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const logs = await prisma.operationLog.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 100 });
    return res.json(logs);
  } catch (error) {
    console.error("Erro getCompanyOperationLogs:", error);
    return res.status(500).json({ error: "Erro ao carregar histórico." });
  }
}

export async function createCompanyOperationLog(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const body = req.body || {};
    const log = await logOperation(companyId, {
      category: clean(body.category || "manual"),
      action: clean(body.action || "manual_note"),
      title: clean(body.title || "Anotação operacional"),
      details: clean(body.details),
      status: clean(body.status || "done"),
      metadata: body.metadata || undefined,
      createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin",
    });
    return res.status(201).json(log);
  } catch (error) {
    console.error("Erro createCompanyOperationLog:", error);
    return res.status(500).json({ error: "Erro ao registrar histórico." });
  }
}

export async function validateCompanyLanding(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const result = await validateLandingForCompany(companyId);
    await logOperation(companyId, {
      category: "landing",
      action: "validate_landing",
      title: result.ok ? "Landing validada com sucesso" : "Landing precisa de ajustes",
      details: result.issues.join(" | "),
      status: result.ok ? "done" : "attention",
      metadata: result,
      createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin",
    });
    return res.json(result);
  } catch (error) {
    console.error("Erro validateCompanyLanding:", error);
    return res.status(500).json({ error: "Erro ao validar landing." });
  }
}

export async function getCompanyWeeklyReport(req: Request, res: Response) {
  try {
    const companyId = String(req.params.id);
    const company = await prisma.company.findUnique({ where: { id: companyId }, include: { adsWorkspaceConfig: true } });
    if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
    const [intel, logs] = await Promise.all([
      buildLeadIntelligence(companyId),
      prisma.operationLog.findMany({ where: { companyId, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } }, orderBy: { createdAt: "desc" }, take: 30 }),
    ]);
    const lines = [
      `Relatório semanal StayGoBot - ${company.name}`,
      "",
      `Leads capturados: ${intel.total}`,
      `Leads qualificados: ${intel.qualified}`,
      `Contratos registrados: ${intel.contracted}`,
      `Receita atribuída: R$ ${Number(intel.closedRevenue || 0).toFixed(2)}`,
      `Taxa de qualificação: ${intel.qualificationRate}%`,
      "",
      "Ações executadas:",
      ...(logs.length ? logs.map((log) => `- ${log.title}: ${log.details || log.action}`) : ["- Nenhuma ação registrada nos últimos 7 dias."]),
      "",
      "Próximos passos:",
      ...buildNextActions(intel, company.adsWorkspaceConfig, null, null).map((item) => `- ${item.title}: ${item.details}`),
    ];
    await logOperation(companyId, { category: "report", action: "weekly_report_generated", title: "Relatório semanal gerado", details: "Relatório executivo criado pelo admin.", createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin" });
    return res.json({ company: company.name, generatedAt: new Date(), report: lines.join("\n") });
  } catch (error) {
    console.error("Erro getCompanyWeeklyReport:", error);
    return res.status(500).json({ error: "Erro ao gerar relatório semanal." });
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

    await logOperation(companyId, {
      category: "billing",
      action: "subscription_updated",
      title: "Assinatura atualizada",
      details: `Plano ${subscription.plan}, status ${subscription.status}, valor R$ ${moneyFromCents(subscription.amountCents).toFixed(2)}`,
      metadata: { subscriptionId: subscription.id, plan: subscription.plan, status: subscription.status, amountCents: subscription.amountCents },
      createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin",
    });

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

    await logOperation(companyId, {
      category: "billing",
      action: "payment_created",
      title: "Pagamento registrado",
      details: `Status ${payment.status}, valor R$ ${moneyFromCents(payment.amountCents).toFixed(2)}`,
      metadata: { paymentId: payment.id, status: payment.status, amountCents: payment.amountCents },
      createdBy: (req.auth as any)?.email || (req.auth as any)?.userId || "Admin",
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
