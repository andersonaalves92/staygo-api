import { prisma } from "./prisma";

type AssistantConfig = {
  enabled: boolean;
  responseMode?: string;
  openAiApiKey?: string | null;
  businessDescription: string;
  tone: string;
  instructions: string;
  handoffKeywords: string;
  fallbackMessage: string;
  urgentAlertPhone?: string | null;
  maxContextMessages: number;
};

type GenerateReplyInput = {
  companyId: string;
  conversationId?: string;
  message: string;
  mode?: "reply" | "summary";
};

const defaultConfig: AssistantConfig = {
  enabled: false,
  responseMode: "auto",
  openAiApiKey: null,
  businessDescription: "",
  tone: "profissional, humano e objetivo",
  instructions: "",
  handoffKeywords: "preço,valor,contrato,humano,atendente,reclamação,cancelar,prisão,preso,flagrante,audiência,mandado,intimação,delegacia,violência,urgente,ameaça,busca e apreensão",
  fallbackMessage: "Certo, me conta seu caso e como posso te ajudar. Vou acionar um advogado para acompanhar também.",
  urgentAlertPhone: "",
  maxContextMessages: 8,
};

export function hasOpenAiConfig(companyApiKey?: string | null) {
  return Boolean(companyApiKey || process.env.OPENAI_API_KEY);
}

function getOpenAiApiKey(config?: Pick<AssistantConfig, "openAiApiKey"> | null) {
  return config?.openAiApiKey || process.env.OPENAI_API_KEY || "";
}

export async function getAssistantConfig(companyId: string) {
  const config = await prisma.aiAssistantConfig.findUnique({ where: { companyId } });
  return config || null;
}

export async function getOrCreateAssistantConfig(companyId: string) {
  const existing = await getAssistantConfig(companyId);
  if (existing) return existing;

  return prisma.aiAssistantConfig.create({
    data: {
      companyId,
      ...defaultConfig,
    },
  });
}

export function shouldHandoff(config: AssistantConfig, message: string) {
  const text = String(message || "").toLowerCase();
  const keywords = config.handoffKeywords
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return keywords.some((keyword) => text.includes(keyword));
}

function normalizeGreetingText(message: string) {
  return String(message || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimpleGreeting(message: string) {
  const text = normalizeGreetingText(message);
  if (!text) return false;
  return [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "opa",
    "e ai",
    "tudo bem",
    "oi tudo bem",
    "ola tudo bem",
  ].includes(text);
}

function greetingReply(message: string) {
  const text = normalizeGreetingText(message);
  if (text.includes("bom dia")) return "Bom dia! Eu sou a Laura, assistente do escritório. Me conta seu caso para eu entender melhor.";
  if (text.includes("boa tarde")) return "Boa tarde! Eu sou a Laura, assistente do escritório. Me conta seu caso para eu entender melhor.";
  if (text.includes("boa noite")) return "Boa noite! Eu sou a Laura, assistente do escritório. Me conta seu caso para eu entender melhor.";
  return "Olá! Eu sou a Laura, assistente do escritório. Me conta seu caso para eu entender melhor.";
}

function makeReplyShortAndHuman(reply: string, fallback: string) {
  const raw = String(reply || fallback || "").trim();
  if (!raw) return fallback;

  const cleaned = raw
    .replace(/\n\s*\d+[.)]\s+/g, "\n")
    .replace(/\n\s*[-*]\s+/g, "\n")
    .replace(/\n{2,}/g, " ")
    .trim();

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const short = sentences.length > 0 ? sentences.slice(0, 2).join(" ") : cleaned;
  return short.length > 240 ? short.slice(0, 237).trimEnd() + "..." : short;
}

function handoffReply(message: string) {
  const text = normalizeGreetingText(message);
  if (text.includes("habeas corpus")) {
    return "Entendi. Vou acionar um advogado agora. Me conta, em poucas palavras, o que aconteceu e em qual cidade você está?";
  }

  return "Entendi. Vou acionar um advogado agora. Me conta, em poucas palavras, o que aconteceu?";
}

async function buildConversationContext(conversationId?: string, maxContextMessages = 10) {
  if (!conversationId) return "";

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(maxContextMessages, 30)),
  });

  return messages
    .reverse()
    .map((message) => `${message.direction === "inbound" ? "Cliente" : "Atendente"}: ${message.body}`)
    .join("\n");
}

async function buildKnowledge(companyId: string) {
  const items = await prisma.knowledgeItem.findMany({
    where: { companyId, active: true },
    orderBy: [{ category: "asc" }, { createdAt: "asc" }],
    take: 30,
  });

  if (items.length === 0) return "";

  return items
    .map((item) => `[${item.category}] ${item.title}\n${item.content}`)
    .join("\n\n");
}

function buildInstructions(config: AssistantConfig, knowledge = "") {
  return [
    "Voce e Laura, assistente de atendimento via WhatsApp da empresa.",
    "Responda em portugues do Brasil.",
    "Quando for natural, apresente-se como Laura, assistente do escritório. Nao diga que e inteligencia artificial.",
    "Sempre responda curto, natural e humano, como uma pessoa real atendendo no WhatsApp.",
    "Isso vale para qualquer mensagem, nao apenas saudacoes.",
    "Evite textao. Responda em 1 a 3 frases curtas, com no maximo 320 caracteres quando possivel.",
    "Se precisar perguntar algo, faça apenas uma pergunta por vez.",
    "Personalize usando o que o cliente acabou de falar. Nao responda de forma generica.",
    "Toda primeira resposta ao cliente deve começar com uma saudação humana e curta.",
    "Depois da saudação, convide a pessoa a contar mais sobre o caso com uma frase simples, por exemplo: 'Me conta seu caso e como posso te ajudar.'",
    "Se a mensagem do cliente for apenas uma saudação, responda somente com saudação + pedido para contar o caso. Nao faça triagem, nao cite advogado, nao cite urgencia e nao mande lista.",
    "Em respostas seguintes, mantenha uma saudação curta quando fizer sentido e siga o contexto da conversa.",
    "Nao use lista numerada em respostas automaticas. Nao use listas longas, linguagem robotizada, juridiquês, emoji em excesso ou texto com cara de propaganda.",
    "Nao invente preco, prazo, garantia, disponibilidade ou condicoes comerciais.",
    "Quando precisar de dados para orcamento, faca no maximo uma pergunta objetiva por mensagem.",
    "Se o cliente pedir algo sensivel, juridico, financeiro, cancelamento ou falar com humano, encaminhe para atendimento humano.",
    "Para escritórios de advocacia, respeite limites éticos: não prometa resultado, não garanta êxito, não capte cliente de forma abusiva e não substitua análise jurídica profissional.",
    "Em casos criminais, pergunte somente dados objetivos de triagem: o que aconteceu, cidade, urgência, existência de flagrante/intimação/audiência e melhor horário de contato.",
    "Quando houver prisão, flagrante, audiência próxima, mandado, ameaça, violência, busca e apreensão ou risco imediato, avise de forma curta que vai acionar um advogado humano.",
    "Evite linguagem sensacionalista. Seja acolhedor, discreto, profissional e objetivo.",
    `Tom de voz: ${config.tone || defaultConfig.tone}.`,
    config.businessDescription ? `Sobre a empresa:\n${config.businessDescription}` : "",
    knowledge ? `Conhecimento da empresa:\n${knowledge}` : "",
    config.instructions ? `Instrucoes especificas:\n${config.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function generateAssistantReply(input: GenerateReplyInput) {
  const config = await getOrCreateAssistantConfig(input.companyId);

  if (!config.enabled) {
    return { enabled: false, reply: null, handoff: false, reason: "assistant_disabled" };
  }

  const openAiApiKey = getOpenAiApiKey(config);

  if (!hasOpenAiConfig(openAiApiKey)) {
    return { enabled: true, reply: null, handoff: false, responseMode: config.responseMode || "auto", reason: "openai_not_configured" };
  }

  if (input.mode !== "summary" && isSimpleGreeting(input.message)) {
    return {
      enabled: true,
      reply: greetingReply(input.message),
      handoff: false,
      responseMode: config.responseMode || "auto",
      reason: "simple_greeting",
    };
  }

  if (input.mode !== "summary" && shouldHandoff(config, input.message)) {
    return {
      enabled: true,
      reply: handoffReply(input.message),
      handoff: true,
      responseMode: config.responseMode || "auto",
      reason: "handoff_keyword",
    };
  }

  const context = await buildConversationContext(input.conversationId, config.maxContextMessages);
  const knowledge = await buildKnowledge(input.companyId);
  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  const userContent = input.mode === "summary"
    ? `Analise a conversa abaixo e retorne um resumo curto, temperatura do lead (frio, morno ou quente), tags sugeridas e proxima acao recomendada.\n\n${context || input.message}`
    : context
      ? `Historico recente:\n${context}\n\nNova mensagem do cliente:\n${input.message}`
      : `Mensagem do cliente:\n${input.message}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: buildInstructions(config, knowledge),
      input: [
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Erro ao gerar resposta com IA");
  }

  const reply = makeReplyShortAndHuman(String(data?.output_text || "").trim(), config.fallbackMessage);

  return {
    enabled: true,
    reply: reply || config.fallbackMessage,
    handoff: false,
    responseMode: config.responseMode || "auto",
    reason: "generated",
  };
}


function parseQuickReplies(text: string) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 3);
    if (Array.isArray(parsed?.replies)) return parsed.replies.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 3);
  } catch {
    // Fallback abaixo para respostas em texto simples.
  }
  return raw.split(/\n+/).map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 3);
}

export async function generateQuickReplies(input: GenerateReplyInput) {
  const config = await getOrCreateAssistantConfig(input.companyId);
  if (!config.enabled) return { enabled: false, replies: [], reason: "assistant_disabled" };
  const openAiApiKey = getOpenAiApiKey(config);
  if (!hasOpenAiConfig(openAiApiKey)) return { enabled: true, replies: [], reason: "openai_not_configured" };
  const context = await buildConversationContext(input.conversationId, config.maxContextMessages);
  const knowledge = await buildKnowledge(input.companyId);
  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const latestMessage = input.message || context || "";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + openAiApiKey,
    },
    body: JSON.stringify({
      model,
      instructions: [
        buildInstructions(config, knowledge),
        "Gere exatamente 3 opcoes curtas de resposta rapida para o atendente usar no WhatsApp.",
        "As opcoes devem respeitar o segmento, tom, regras e conhecimento da empresa.",
        "Nao invente dados, valores, prazos ou garantias.",
        "Retorne somente JSON valido no formato {\"replies\":[\"...\",\"...\",\"...\"]}.",
      ].join("\n\n"),
      input: [{
        role: "user",
        content: context ? "Historico recente:\n" + context + "\n\nMensagem mais recente/objetivo:\n" + latestMessage : "Mensagem do cliente:\n" + latestMessage,
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Erro ao gerar respostas rapidas com IA");
  return { enabled: true, replies: parseQuickReplies(data?.output_text || ""), reason: "generated" };
}