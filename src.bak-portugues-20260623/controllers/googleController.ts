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

function mask(value?: string | null) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return value.slice(0, 4) + "..." + value.slice(-4);
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

async function ga4Report(integration: any, token: string) {
  if (!integration.ga4PropertyId || !token) return null;
  const response = await fetch("https://analyticsdata.googleapis.com/v1beta/properties/" + integration.ga4PropertyId + ":runReport", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "eventCount" }, { name: "conversions" }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Erro ao buscar GA4");
  return data;
}

async function adsReport(integration: any, token: string) {
  const customerId = String(integration.googleAdsCustomerId || "").replace(/\D/g, "");
  const developerToken = integration.googleAdsDeveloperToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  if (!customerId || !developerToken || !token) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
    "developer-token": developerToken,
  };
  if (integration.googleAdsLoginCustomerId) headers["login-customer-id"] = String(integration.googleAdsLoginCustomerId).replace(/\D/g, "");
  const query = "SELECT campaign.name, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.clicks DESC LIMIT 20";
  const response = await fetch("https://googleads.googleapis.com/v24/customers/" + customerId + "/googleAds:search", {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || JSON.stringify(data?.error || data).slice(0, 300));
  return data;
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

  try { analytics = await ga4Report(integration, token); } catch (error) { errors.push(error instanceof Error ? error.message : "Erro GA4"); }
  try { ads = await adsReport(integration, token); } catch (error) { errors.push(error instanceof Error ? error.message : "Erro Ads"); }
  await prisma.googleIntegration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date() } }).catch(() => null);
  return res.json({ connected: Boolean(integration.oauthRefreshToken && token), analytics, ads, errors });
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
    errors.push("Informe o Developer Token para listar contas do Google Ads.");
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
