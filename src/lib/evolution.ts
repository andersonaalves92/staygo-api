type EvolutionResponse = Record<string, any>;

const baseUrl = (process.env.EVOLUTION_API_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const apiKey = process.env.EVOLUTION_API_KEY || "";

export function hasEvolutionConfig() {
  return Boolean(baseUrl && apiKey);
}

async function request(path: string, options: RequestInit = {}) {
  if (!hasEvolutionConfig()) {
    throw new Error("Evolution API nao configurada");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const snippet = text.slice(0, 180).replace(/\s+/g, " " );
    throw new Error("Evolution API retornou resposta invalida (HTTP " + response.status + "): " + snippet);
  }

  if (!response.ok) {
    const message = data?.response?.message?.[0] || data?.message || data?.error || "Erro na Evolution API";
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data as EvolutionResponse;
}

export function extractQrCode(data: EvolutionResponse) {
  return (
    data?.qrcode?.base64 ||
    data?.qrcode?.code ||
    data?.base64 ||
    data?.code ||
    data?.data?.qrcode?.base64 ||
    data?.data?.base64 ||
    ""
  );
}

export async function createEvolutionInstance(instanceName: string) {
  return request("/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    }),
  });
}

export async function connectEvolutionInstance(instanceName: string) {
  return request(`/instance/connect/${encodeURIComponent(instanceName)}`, {
    method: "GET",
  });
}

export async function getEvolutionConnectionState(instanceName: string) {
  return request(`/instance/connectionState/${encodeURIComponent(instanceName)}`, {
    method: "GET",
  });
}

export async function setEvolutionWebhook(instanceName: string) {
  const webhookUrl =
    process.env.EVOLUTION_WEBHOOK_URL || "https://n8n.staygobot.com/webhook/evolution-in";

  return request(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        webhookByEvents: false,
        webhookBase64: false,
        headers: process.env.EVOLUTION_WEBHOOK_TOKEN
          ? { "x-staygobot-webhook-token": process.env.EVOLUTION_WEBHOOK_TOKEN }
          : undefined,
        events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"],
      },
    }),
  });
}

export async function sendEvolutionText(instanceName: string, phone: string, text: string) {
  const number = String(phone || "").replace(/\D/g, "");

  return request(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      number,
      text,
    }),
  });
}

export async function getEvolutionMediaBase64(instanceName: string, message: any) {
  const data = await request("/chat/getBase64FromMediaMessage/" + encodeURIComponent(instanceName), {
    method: "POST",
    body: JSON.stringify({ message }),
  });

  return (
    data?.base64 ||
    data?.data?.base64 ||
    data?.file?.base64 ||
    data?.media?.base64 ||
    data?.message?.base64 ||
    ""
  );
}
