import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

function getId(param: any): string { return Array.isArray(param) ? param[0] : param; }
function onlyDigits(value: any) { return String(value || "").replace(/\D/g, ""); }
function clean(value: any, fallback = "") { return String(value ?? fallback).trim(); }
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
function leadPayload(body: any) {
  const phone = onlyDigits(body.phone || body.whatsapp || body.telefone);
  const message = clean(body.message || body.caseDescription || body.caso || body.description, "Lead capturado pela landing page.");
  return {
    phone,
    contactName: clean(body.contactName || body.name || body.nome) || null,
    message,
    city: clean(body.city || body.cidade) || null,
    area: clean(body.area || body.practiceArea || body.tipoCaso) || null,
    urgency: clean(body.urgency || body.urgencia) || null,
    source: clean(body.source || body.utm_source || "landing") || null,
    campaign: clean(body.campaign || body.utm_campaign) || null,
    keyword: clean(body.keyword || body.utm_term) || null,
    pageUrl: clean(body.pageUrl || body.url || body.referrer) || null,
    device: clean(body.device || body.dispositivo) || null,
    capturedFrom: clean(body.capturedFrom || "landing_page"),
    stage: clean(body.stage || "novo"),
    status: clean(body.status || "novo"),
  };
}
function whatsappUrl(phone: string, lead: any) {
  const to = onlyDigits(phone);
  if (!to) return "";
  const lines = [
    "Ola, vim pelo atendimento online.",
    lead.contactName ? "Nome: " + lead.contactName : "",
    lead.phone ? "Telefone: " + lead.phone : "",
    lead.city ? "Cidade: " + lead.city : "",
    lead.area ? "Area/caso: " + lead.area : "",
    lead.urgency ? "Urgencia: " + lead.urgency : "",
    lead.message ? "Resumo: " + lead.message : "",
  ].filter(Boolean);
  return "https://wa.me/" + to + "?text=" + encodeURIComponent(lines.join("\n"));
}

export async function createLead(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const payload = leadPayload(req.body || {});
    if (!payload.phone) return res.status(400).json({ error: "Informe o telefone do lead." });
    const lead = await prisma.lead.create({ data: { ...payload, companyId } });
    return res.json(lead);
  } catch (error) {
    console.error("Erro createLead:", error);
    return res.status(500).json({ error: "Erro ao criar lead." });
  }
}

export async function listLeads(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const leads = await prisma.lead.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
  return res.json(leads);
}

export async function getLeadFunnel(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const leads = await prisma.lead.groupBy({ by: ["stage"], where: { companyId }, _count: { _all: true } });
  return res.json(leads.map((row) => ({ stage: row.stage, total: row._count._all })));
}

export async function listConversations(_req: Request, res: Response) { return res.json([]); }

export async function updateLeadStage(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const id = getId(req.params.id);
  const { stage } = req.body;
  const result = await prisma.lead.updateMany({ where: { id, companyId }, data: { stage: clean(stage || "novo") } });
  if (result.count === 0) return res.status(404).json({ error: "Lead nao encontrado" });
  const lead = await prisma.lead.findFirst({ where: { id, companyId } });
  return res.json(lead);
}

export async function getCaptureSettings(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, publicSlug: true, leadWhatsappNumber: true, leadReportEmail: true } });
  if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
  const publicSlug = await ensureCompanySlug(company.id, company.name);
  return res.json({ ...company, publicSlug, publicLeadUrl: "/capturar/" + publicSlug, apiEndpoint: "/api/public/capture/" + publicSlug + "/leads" });
}

export async function saveCaptureSettings(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const body = req.body || {};
  const current = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!current) return res.status(404).json({ error: "Empresa nao encontrada." });
  let publicSlug = clean(body.publicSlug);
  if (!publicSlug) publicSlug = await ensureCompanySlug(companyId, current.name);
  publicSlug = slugify(publicSlug);
  const exists = await prisma.company.findFirst({ where: { publicSlug, NOT: { id: companyId } }, select: { id: true } });
  if (exists) return res.status(409).json({ error: "Este slug publico ja esta em uso." });
  const company = await prisma.company.update({ where: { id: companyId }, data: { publicSlug, leadWhatsappNumber: onlyDigits(body.leadWhatsappNumber), leadReportEmail: clean(body.leadReportEmail) }, select: { id: true, name: true, publicSlug: true, leadWhatsappNumber: true, leadReportEmail: true } });
  return res.json({ ...company, publicLeadUrl: "/capturar/" + company.publicSlug, apiEndpoint: "/api/public/capture/" + company.publicSlug + "/leads" });
}

export async function getPublicCaptureConfig(req: Request, res: Response) {
  const slug = clean(req.params.slug).toLowerCase();
  const company = await prisma.company.findFirst({ where: { publicSlug: slug, status: "active" }, select: { name: true, publicSlug: true } });
  if (!company) return res.status(404).json({ error: "Pagina nao encontrada." });
  return res.json({ companyName: company.name, publicSlug: company.publicSlug });
}

export async function createPublicLead(req: Request, res: Response) {
  try {
    const slug = clean(req.params.slug).toLowerCase();
    const company = await prisma.company.findFirst({ where: { publicSlug: slug, status: "active" }, select: { id: true, name: true, leadWhatsappNumber: true } });
    if (!company) return res.status(404).json({ error: "Empresa nao encontrada." });
    const payload = leadPayload({ ...(req.body || {}), capturedFrom: "public_landing" });
    if (!payload.phone) return res.status(400).json({ error: "Informe seu WhatsApp para continuar." });
    const lead = await prisma.lead.create({ data: { ...payload, companyId: company.id } });
    return res.json({ ok: true, leadId: lead.id, whatsappUrl: whatsappUrl(company.leadWhatsappNumber, lead), message: "Lead registrado no StayGoBot." });
  } catch (error) {
    console.error("Erro createPublicLead:", error);
    return res.status(500).json({ error: "Nao foi possivel registrar o lead." });
  }
}


function numberOrNull(value: any) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
function dateOrNull(value: any) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function updateLeadQualification(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const id = getId(req.params.id);
  const body = req.body || {};
  const data: any = {
    qualificationStatus: clean(body.qualificationStatus || "nao_qualificado"),
    lossReason: clean(body.lossReason) || null,
    qualificationNotes: clean(body.qualificationNotes) || null,
  };
  const qualityScore = numberOrNull(body.qualityScore);
  const leadScore = numberOrNull(body.leadScore);
  const potentialValue = numberOrNull(body.potentialValue);
  const closedValue = numberOrNull(body.closedValue);
  if (qualityScore !== null) data.qualityScore = Math.max(0, Math.min(10, Math.round(qualityScore)));
  if (leadScore !== null) data.leadScore = Math.max(0, Math.min(100, Math.round(leadScore)));
  if (potentialValue !== null) data.potentialValue = potentialValue;
  if (closedValue !== null) data.closedValue = closedValue;
  data.appointmentAt = dateOrNull(body.appointmentAt);
  data.contractedAt = dateOrNull(body.contractedAt);
  if (data.qualificationStatus === "contratado" && !data.contractedAt) data.contractedAt = new Date();
  const stageByStatus: Record<string, string> = { qualificado: "em triagem", consulta_marcada: "consulta marcada", contratado: "contratado", perdido: "perdido", ruim: "perdido" };
  if (stageByStatus[data.qualificationStatus]) data.stage = stageByStatus[data.qualificationStatus];
  const result = await prisma.lead.updateMany({ where: { id, companyId }, data });
  if (result.count === 0) return res.status(404).json({ error: "Lead nao encontrado" });
  const lead = await prisma.lead.findFirst({ where: { id, companyId } });
  return res.json(lead);
}

export async function getLeadIntelligence(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const since = new Date(Date.now() - 30 * 86400000);
  const leads = await prisma.lead.findMany({ where: { companyId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });
  const total = leads.length;
  const qualified = leads.filter((l) => ["qualificado", "consulta_marcada", "contratado"].includes(l.qualificationStatus)).length;
  const contracted = leads.filter((l) => l.qualificationStatus === "contratado" || l.stage === "contratado").length;
  const lost = leads.filter((l) => ["perdido", "ruim"].includes(l.qualificationStatus) || l.stage === "perdido").length;
  const urgent = leads.filter((l) => String(l.urgency || "").toLowerCase().includes("urg") || l.stage === "urgente").length;
  const closedRevenue = leads.reduce((sum, lead: any) => sum + Number(lead.closedValue || 0), 0);
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
  if (total && qualified / total < 0.35) recommendations.push("A taxa de qualifica??o est? baixa. Revise termos de busca, promessa da landing page e perguntas do formul?rio.");
  if (lossReasons[0]?.reason && lossReasons[0].reason !== "sem motivo") recommendations.push("Principal motivo de perda: " + lossReasons[0].reason + ". Use isso para negativar termos e ajustar a oferta.");
  if (campaigns[0]?.contracted > 0) recommendations.push("Campanha com melhor sinal de contrato: " + campaigns[0].name + ". Priorize orcamento e variacoes proximas.");
  if (!recommendations.length) recommendations.push("Ainda faltam dados de qualificacao. Marque leads como qualificado, perdido ou contratado para o algoritmo comercial aprender.");
  return res.json({ period: "30 dias", total, qualified, contracted, lost, urgent, closedRevenue, qualificationRate: total ? Math.round((qualified / total) * 100) : 0, contractRate: total ? Math.round((contracted / total) * 100) : 0, campaigns, keywords, lossReasons, recommendations });
}

export async function exportOfflineConversions(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const leads = await prisma.lead.findMany({ where: { companyId, OR: [{ qualificationStatus: "contratado" }, { stage: "contratado" }] }, orderBy: { createdAt: "desc" } });
  const header = ["lead_id", "phone", "contact_name", "campaign", "keyword", "conversion_name", "conversion_time", "conversion_value", "currency"].join(",");
  const rows = leads.map((lead: any) => [lead.id, lead.phone, lead.contactName || "", lead.campaign || "", lead.keyword || "", "Contrato fechado", (lead.contractedAt || lead.createdAt).toISOString(), Number(lead.closedValue || lead.potentialValue || 0).toFixed(2), "BRL"].map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=conversoes-offline-staygobot.csv");
  return res.send([header, ...rows].join("\\n"));
}
