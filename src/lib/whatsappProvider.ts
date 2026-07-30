import { sendEvolutionText } from "./evolution";

type InstanceLike = {
  instanceName: string;
  provider?: string | null;
  metaPhoneNumberId?: string | null;
  metaAccessToken?: string | null;
};

function graphVersion() {
  return process.env.META_GRAPH_VERSION || "v20.0";
}

function metaMessageId(data: any) {
  return data?.messages?.[0]?.id || data?.message_id || data?.id || null;
}

export function isOfficialMetaInstance(instance?: InstanceLike | null) {
  return Boolean(
    instance &&
      instance.provider === "meta_cloud_api" &&
      instance.metaPhoneNumberId &&
      instance.metaAccessToken
  );
}

export function canSendWhatsApp(instance?: (InstanceLike & { status?: string | null }) | null) {
  if (!instance) return false;
  if (isOfficialMetaInstance(instance)) return true;
  return String(instance.status || "").toLowerCase() === "connected";
}

export async function sendMetaText(instance: InstanceLike, phone: string, text: string) {
  if (!instance.metaPhoneNumberId || !instance.metaAccessToken) {
    throw new Error("Meta Cloud API nao configurada para esta empresa");
  }

  const number = String(phone || "").replace(/\D/g, "");
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(instance.metaPhoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${instance.metaAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: number,
        type: "text",
        text: { preview_url: false, body: text },
      }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || "Erro ao enviar pela Meta Cloud API";
    throw new Error(message);
  }

  return { provider: "meta_cloud_api", id: metaMessageId(data), raw: data };
}

export async function sendWhatsAppText(instance: InstanceLike, phone: string, text: string) {
  if (isOfficialMetaInstance(instance)) {
    return sendMetaText(instance, phone, text);
  }

  const sent = await sendEvolutionText(instance.instanceName, phone, text);
  const id = sent?.key?.id || sent?.message?.key?.id || sent?.data?.key?.id || null;
  return { provider: "evolution_qr", id, raw: sent };
}

export async function getMetaMediaBytes(mediaId: string, accessToken: string) {
  const metaResponse = await fetch(
    `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !meta?.url) {
    throw new Error(meta?.error?.message || "Nao foi possivel buscar midia na Meta");
  }

  const mediaResponse = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!mediaResponse.ok) throw new Error("Nao foi possivel baixar midia da Meta");
  const arrayBuffer = await mediaResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
