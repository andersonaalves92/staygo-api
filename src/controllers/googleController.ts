import { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";

const defaultEmail = "atis.projetosdevolps@gmail.com";
const scopes = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/analytics.readonly",
];

function redirectUri(req: Request) {
  return process.env.GOOGLE_REDIRECT_URI || "https://app.staygobot.com/api/admin/google/oauth/callback";
}

async function getIntegration() {
  const existing = await prisma.googleIntegration.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) return existing;
  return prisma.googleIntegration.create({ data: { accountEmail: defaultEmail } });
}

function oauthClient(integration: any, req: Request) {
  const clientId = integration.oauthClientId || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = integration.oauthClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return new OAuth2Client(clientId, clientSecret, redirectUri(req));
}

function googleAdsErrorMessage(data: any) {
  const detailMessage = data?.error?.details?.flatMap((detail: any) => detail?.errors || [])?.map((item: any) => item?.message)?.filter(Boolean)?.[0];
  const code = data?.error?.details?.flatMap((detail: any) => detail?.errors || [])?.map((item: any) => item?.errorCode?.authorizationError || item?.errorCode?.requestError)?.filter(Boolean)?.[0];
  if (code === "DEVELOPER_TOKEN_NOT_APPROVED") return "Google Ads conectado, mas o Developer Token ainda está liberado apenas para contas de teste. Solicite acesso Basic ou Standard no API Center para puxar campanhas reais.";
  return detailMessage || data?.error?.message || JSON.stringify(data?.error || data).slice(0, 300);
}

function currentMonthStartForGoogle() {
  const now = new Date();
  const brazilNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const year = brazilNow.getUTCFullYear();
  const month = String(brazilNow.getUTCMonth() + 1).padStart(2, "0");
  return year + "-" + month + "-01";
}

function adsDateRange(value: any) {
  const raw = String(value || "month").toLowerCase();
  const days = raw.replace(/\D/g, "");
  if (raw === "month" || raw === "mes" || raw === "mês" || raw === "this_month" || !days) return { ads: "THIS_MONTH", ga4: currentMonthStartForGoogle(), label: "mês atual" };
  if (days === "7") return { ads: "LAST_7_DAYS", ga4: "7daysAgo", label: "7 dias" };
  if (days === "30") return { ads: "LAST_30_DAYS", ga4: "30daysAgo", label: "30 dias" };
  if (days === "90") return { ads: "LAST_90_DAYS", ga4: "90daysAgo", label: "90 dias" };
  return { ads: "THIS_MONTH", ga4: currentMonthStartForGoogle(), label: "mês atual" };
}

function gaqlString(value: string) { return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function campaignFilter(query: any) {
  const id = String(query.campaignId || "").replace(/\D/g, "");
  const name = String(query.campaignName || "").trim();
  if (id) return " AND campaign.id = " + id;
  if (name) return " AND campaign.name LIKE '%" + gaqlString(name) + "%'";
  return "";
}

function mask(value?: string | null) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

async function logGoogleOperationByCampaign(campaignId: string, data: { action: string; title: string; details?: string; status?: string; metadata?: any }) {
  try {
    const config = await prisma.adsWorkspaceConfig.findFirst({
      where: {
        OR: [
          { googleCampaignId: campaignId },
          { googleCampaignName: { contains: campaignId } },
        ],
      },
      select: { companyId: true },
    });
    if (!config?.companyId) return null;
    return prisma.operationLog.create({
      data: {
        companyId: config.companyId,
        category: "google_ads",
        action: data.action,
        title: data.title,
        details: data.details || "",
        status: data.status || "done",
        metadata: data.metadata || undefined,
        createdBy: "Google Ads API",
      },
    });
  } catch (error) {
    console.error("Erro logGoogleOperationByCampaign:", error);
    return null;
  }
}

export async function getGoogleIntegration(_req: Request, res: Response) {
  const integration = await getIntegration();
  return res.json({
    ...integration,
    oauthClientSecret: integration.oauthClientSecret ? mask(integration.oauthClientSecret) : "",
    googleAdsDeveloperToken: integration.googleAdsDeveloperToken ? mask(integration.googleAdsDeveloperToken) : "",
    hasRefreshToken: Boolean(integration.oauthRefreshToken),
    oauthRefreshToken: undefined,
  });
}

export async function saveGoogleIntegration(req: Request, res: Response) {
  const current = await getIntegration();
  const body = req.body || {};
  const data: any = {
    accountEmail: String(body.accountEmail || current.accountEmail || defaultEmail),
    oauthClientId: body.oauthClientId !== undefined ? String(body.oauthClientId || "") : current.oauthClientId,
    googleAdsCustomerId: body.googleAdsCustomerId !== undefined ? String(body.googleAdsCustomerId || "").replace(/\D/g, "") : current.googleAdsCustomerId,
    googleAdsLoginCustomerId: body.googleAdsLoginCustomerId !== undefined ? String(body.googleAdsLoginCustomerId || "").replace(/\D/g, "") : current.googleAdsLoginCustomerId,
    ga4PropertyId: body.ga4PropertyId !== undefined ? String(body.ga4PropertyId || "").replace(/\D/g, "") : current.ga4PropertyId,
  };
  if (body.oauthClientSecret && !String(body.oauthClientSecret).includes("...")) data.oauthClientSecret = String(body.oauthClientSecret);
  if (body.googleAdsDeveloperToken && !String(body.googleAdsDeveloperToken).includes("...")) data.googleAdsDeveloperToken = String(body.googleAdsDeveloperToken);
  const saved = await prisma.googleIntegration.update({ where: { id: current.id }, data });
  return res.json({ ok: true, id: saved.id });
}

export async function getGoogleOAuthUrl(req: Request, res: Response) {
  const integration = await getIntegration();
  const client = oauthClient(integration, req);
  if (!client) {
    return res.status(400).json({ error: "Informe Client ID e Client Secret OAuth antes de conectar." });
  }
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state: integration.id,
    login_hint: integration.accountEmail || defaultEmail,
  });
  return res.json({ url: authUrl });
}

export async function googleOAuthCallback(req: Request, res: Response) {
  try {
    const integration = await getIntegration();
    const client = oauthClient(integration, req);
    if (!client) return res.redirect("/ads-analytics?google=missing_oauth");
    const code = String(req.query.code || "");
    if (!code) return res.redirect("/ads-analytics?google=missing_code");
    const { tokens } = await client.getToken(code);
    await prisma.googleIntegration.update({
      where: { id: integration.id },
      data: {
        oauthRefreshToken: tokens.refresh_token || integration.oauthRefreshToken,
        scopes: Array.isArray(tokens.scope) ? tokens.scope.join(" ") : String(tokens.scope || scopes.join(" ")),
        connectedAt: new Date(),
      },
    });
    return res.redirect("/ads-analytics?google=connected");
  } catch (error) {
    console.error("Erro googleOAuthCallback:", error);
    return res.redirect("/ads-analytics?google=error");
  }
}

async function accessToken(integration: any, req: Request) {
  const client = oauthClient(integration, req);
  if (!client || !integration.oauthRefreshToken) return "";
  client.setCredentials({ refresh_token: integration.oauthRefreshToken });
  const token = await client.getAccessToken();
  return token.token || "";
}

async function ga4Report(integration: any, token: string, range = adsDateRange("month")) {
  if (!integration.ga4PropertyId || !token) return null;
  const endpoint = "https://analyticsdata.googleapis.com/v1beta/properties/" + integration.ga4PropertyId + ":runReport";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      dateRanges: [{ startDate: range.ga4, endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "eventCount" }, { name: "conversions" }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Erro ao buscar GA4");
  const sourceResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      dateRanges: [{ startDate: range.ga4, endDate: "today" }],
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "eventCount" }, { name: "conversions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 12,
    }),
  });
  const sourceData = await sourceResponse.json();
  if (!sourceResponse.ok) throw new Error(sourceData?.error?.message || "Erro ao buscar origens GA4");
  return { ...data, sourceRows: sourceData.rows || [], sourceTotals: sourceData.totals || [] };
}

async function googleAdsContext(integration: any, token: string) {
  const customerId = String(integration.googleAdsCustomerId || "").replace(/\D/g, "");
  const developerToken = integration.googleAdsDeveloperToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  if (!customerId || !token) throw new Error("Google Ads ainda não conectado.");
  if (!developerToken) throw new Error("Google Ads conectado por OAuth, mas falta configurar o Developer Token do Google Ads API.");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
    "developer-token": developerToken,
  };
  if (integration.googleAdsLoginCustomerId) headers["login-customer-id"] = String(integration.googleAdsLoginCustomerId).replace(/\D/g, "");
  return { customerId, headers };
}

async function googleAdsSearch(customerId: string, headers: Record<string, string>, query: string) {
  const response = await fetch("https://googleads.googleapis.com/v24/customers/" + customerId + "/googleAds:search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(googleAdsErrorMessage(data));
  return data;
}

async function adsReport(integration: any, token: string, range = adsDateRange("month"), filter = "") {
  const customerId = String(integration.googleAdsCustomerId || "").replace(/\D/g, "");
  const developerToken = integration.googleAdsDeveloperToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  if (!customerId || !token) return null;
  if (!developerToken) throw new Error("Google Ads conectado por OAuth, mas falta configurar o Developer Token do Google Ads API para puxar campanhas no painel.");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
    "developer-token": developerToken,
  };
  if (integration.googleAdsLoginCustomerId) headers["login-customer-id"] = String(integration.googleAdsLoginCustomerId).replace(/\D/g, "");
  const campaignQuery = `SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date DURING ${range.ads}${filter} ORDER BY metrics.clicks DESC LIMIT 30`;
  const keywordQuery = `SELECT campaign.name, ad_group.name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM keyword_view WHERE segments.date DURING ${range.ads}${filter} ORDER BY metrics.clicks DESC LIMIT 60`;
  const searchTermsQuery = `SELECT campaign.id, campaign.name, ad_group.name, search_term_view.search_term, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING ${range.ads}${filter} ORDER BY metrics.cost_micros DESC LIMIT 60`;
  const adsAuditQuery = `SELECT campaign.name, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.status != REMOVED AND ad_group_ad.status != REMOVED${filter} ORDER BY ad_group_ad.ad.id DESC LIMIT 40`;
  const negativeQuery = `SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE${filter} LIMIT 200`;
  const keywordAuditQuery = `SELECT campaign.name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view WHERE campaign.status != REMOVED${filter} LIMIT 200`;
  const deviceQuery = `SELECT campaign.name, segments.device, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING ${range.ads}${filter} ORDER BY metrics.cost_micros DESC LIMIT 60`;
  const hourQuery = `SELECT segments.hour, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE segments.date DURING ${range.ads} ORDER BY metrics.cost_micros DESC LIMIT 24`;
  const geoQuery = `SELECT campaign.name, geographic_view.country_criterion_id, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM geographic_view WHERE segments.date DURING ${range.ads}${filter} ORDER BY metrics.cost_micros DESC LIMIT 40`;
  const [campaigns, keywords, searchTerms, adsAudit, negatives, keywordAudit, devices, hours, geos] = await Promise.all([
    googleAdsSearch(customerId, headers, campaignQuery),
    googleAdsSearch(customerId, headers, keywordQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao buscar palavras-chave" })),
    googleAdsSearch(customerId, headers, searchTermsQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao buscar termos de busca" })),
    googleAdsSearch(customerId, headers, adsAuditQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao auditar anúncios" })),
    googleAdsSearch(customerId, headers, negativeQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao contar negativas" })),
    googleAdsSearch(customerId, headers, keywordAuditQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao auditar palavras" })),
    googleAdsSearch(customerId, headers, deviceQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao buscar dispositivos" })),
    googleAdsSearch(customerId, headers, hourQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao buscar horários" })),
    googleAdsSearch(customerId, headers, geoQuery).catch((error) => ({ results: [], warning: error instanceof Error ? error.message : "Erro ao buscar localizações" })),
  ]);
  const keywordAuditRows = (keywordAudit as any).results || [];
  return {
    ...campaigns,
    campaigns: campaigns.results || [],
    keywords: (keywords as any).results || [],
    keywordWarning: (keywords as any).warning || null,
    searchTerms: (searchTerms as any).results || [],
    searchTermWarning: (searchTerms as any).warning || null,
    adsAudit: (adsAudit as any).results || [],
    adsAuditWarning: (adsAudit as any).warning || null,
    negatives: (negatives as any).results || [],
    negativeWarning: (negatives as any).warning || null,
    keywordAudit: keywordAuditRows,
    devices: (devices as any).results || [],
    deviceWarning: (devices as any).warning || null,
    hours: (hours as any).results || [],
    hourWarning: (hours as any).warning || null,
    geos: (geos as any).results || [],
    geoWarning: (geos as any).warning || null,
    auditSummary: {
      activeAds: ((adsAudit as any).results || []).filter((row: any) => row.adGroupAd?.status === "ENABLED").length,
      pausedAds: ((adsAudit as any).results || []).filter((row: any) => row.adGroupAd?.status === "PAUSED").length,
      negatives: ((negatives as any).results || []).length,
      enabledKeywords: keywordAuditRows.filter((row: any) => row.adGroupCriterion?.status === "ENABLED").length,
      pausedKeywords: keywordAuditRows.filter((row: any) => row.adGroupCriterion?.status === "PAUSED").length,
    },
    range: range.label,
  };
}

export async function getGoogleMetrics(req: Request, res: Response) {
  const integration = await getIntegration();
  const errors: string[] = [];
  let token = "";
  let analytics: any = null;
  let ads: any = null;

  try {
    token = await accessToken(integration, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro OAuth";
    if (message.includes("invalid_grant")) {
      errors.push("Sessao Google expirada ou revogada. Reconecte o Google.");
      await prisma.googleIntegration.update({ where: { id: integration.id }, data: { oauthRefreshToken: null } }).catch(() => null);
      return res.json({ connected: false, analytics, ads, errors });
    }
    errors.push(message);
    return res.json({ connected: false, analytics, ads, errors });
  }

  const range = adsDateRange(req.query.range);
  const filter = campaignFilter(req.query);
  try { analytics = await ga4Report(integration, token, range); } catch (error) { errors.push(error instanceof Error ? error.message : "Erro GA4"); }
  try { ads = await adsReport(integration, token, range, filter); } catch (error) { errors.push(error instanceof Error ? error.message : "Erro Ads"); }
  await prisma.googleIntegration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date() } }).catch(() => null);
  return res.json({ connected: Boolean(integration.oauthRefreshToken && token), analytics, ads, errors, range: range.label, filterApplied: Boolean(filter) });
}


export async function discoverGoogleAccounts(req: Request, res: Response) {
  const integration = await getIntegration();
  const errors: string[] = [];
  let token = "";
  try {
    token = await accessToken(integration, req);
  } catch (error) {
    return res.status(400).json({ error: "Reconecte o Google antes de buscar contas." });
  }
  if (!token) return res.status(400).json({ error: "Google ainda nao conectado." });

  const adsDeveloperToken = integration.googleAdsDeveloperToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  let adsCustomers: any[] = [];
  if (adsDeveloperToken) {
    try {
      const response = await fetch("https://googleads.googleapis.com/v24/customers:listAccessibleCustomers", {
        headers: { Authorization: "Bearer " + token, "developer-token": adsDeveloperToken },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "Erro ao listar contas Google Ads");
      adsCustomers = (data.resourceNames || []).map((name: string) => ({ id: String(name).replace(/\D/g, ""), resourceName: name, label: String(name).replace("customers/", "Customer ") }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Erro Google Ads");
    }
  } else {
    errors.push("Google Ads conectado, mas falta configurar o Developer Token do Google Ads API para listar e puxar campanhas.");
  }

  let analyticsProperties: any[] = [];
  try {
    const response = await fetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries", {
      headers: { Authorization: "Bearer " + token },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || "Erro ao listar propriedades GA4");
    analyticsProperties = (data.accountSummaries || []).flatMap((account: any) =>
      (account.propertySummaries || []).map((property: any) => ({
        account: account.displayName,
        property: property.displayName,
        propertyId: String(property.property || "").replace(/\D/g, ""),
        label: account.displayName + " / " + property.displayName,
      }))
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Erro Google Analytics");
  }

  return res.json({ adsCustomers, analyticsProperties, errors });
}


export async function addGoogleNegativeKeyword(req: Request, res: Response) {
  try {
    const integration = await getIntegration();
    const token = await accessToken(integration, req);
    const { customerId, headers } = await googleAdsContext(integration, token);
    const text = String(req.body?.text || "").trim();
    const campaignId = String(req.body?.campaignId || "").replace(/\D/g, "");
    const matchType = String(req.body?.matchType || "PHRASE").toUpperCase() === "EXACT" ? "EXACT" : "PHRASE";
    if (!text || text.length < 2) return res.status(400).json({ error: "Informe o termo para negativar." });
    let targetCampaignId = campaignId;
    if (!targetCampaignId) {
      const campaigns = await googleAdsSearch(customerId, headers, "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status = ENABLED LIMIT 1");
      targetCampaignId = String(campaigns.results?.[0]?.campaign?.id || "");
    }
    if (!targetCampaignId) return res.status(400).json({ error: "Não encontrei campanha ativa para negativar o termo." });
    const body = {
      customerId,
      operations: [{
        create: {
          campaign: "customers/" + customerId + "/campaigns/" + targetCampaignId,
          negative: true,
          keyword: { text, matchType },
        },
      }],
      partialFailure: true,
    };
    const response = await fetch("https://googleads.googleapis.com/v24/customers/" + customerId + "/campaignCriteria:mutate", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(400).json({ error: googleAdsErrorMessage(data), raw: data });
    if (data.partialFailureError?.message) {
      return res.status(400).json({ error: data.partialFailureError.message, raw: data });
    }
    console.log("Google Ads negative keyword criada", { text, campaignId: targetCampaignId, matchType });
    await logGoogleOperationByCampaign(targetCampaignId, {
      action: "negative_keyword_created",
      title: "Termo negativado no Google Ads",
      details: `"${text}" aplicado como ${matchType} na campanha ${targetCampaignId}.`,
      metadata: { text, campaignId: targetCampaignId, matchType, result: data.results?.[0] || null },
    });
    return res.json({ ok: true, text, campaignId: targetCampaignId, matchType, result: data.results?.[0] || null, partialFailure: null });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Não foi possível negativar o termo." });
  }
}
