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
  fallbackMessage: "Olá! Me chamo Laura e vou fazer seu primeiro atendimento. Pode me passar seu caso para eu organizar tudo por aqui?",
  urgentAlertPhone: "",
  maxContextMessages: 12,
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

function timeGreeting() {
  const hour = Number(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  }).format(new Date()));
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

function startsWithGreeting(message: string) {
  const text = normalizeGreetingText(message);
  return /^(oi|ola|bom dia|boa tarde|boa noite|opa|e ai)\b/.test(text);
}

function greetingReply(message: string) {
  const text = normalizeGreetingText(message);
  if (text.includes("bom dia")) return "Bom dia! Me chamo Laura e vou fazer seu primeiro atendimento. Pode me passar seu caso?";
  if (text.includes("boa tarde")) return "Boa tarde! Me chamo Laura e vou fazer seu primeiro atendimento. Pode me passar seu caso?";
  if (text.includes("boa noite")) return "Boa noite! Me chamo Laura e vou fazer seu primeiro atendimento. Pode me passar seu caso?";
  return timeGreeting() + "! Me chamo Laura e vou fazer seu primeiro atendimento. Pode me passar seu caso?";
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
  if (/violencia|ameaca|maria da penha|medida protetiva/.test(text)) {
    return "Sinto muito por você estar passando por isso. Você está em um local seguro agora?";
  }
  if (/habeas corpus|preso|prisao|flagrante|custodia/.test(text)) {
    return "Entendi. Pode me dizer quem está preso ou qual é a urgência agora?";
  }
  if (/intimacao|delegacia|policial/.test(text)) {
    return "Entendi. A intimação é para qual data?";
  }

  return "Entendi. Me conta um pouco mais sobre o que aconteceu?";
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

async function isFirstCustomerTurn(conversationId?: string) {
  if (!conversationId) return true;
  const inboundCount = await prisma.message.count({
    where: { conversationId, direction: "inbound" },
  });
  return inboundCount <= 1;
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
    "Na primeira resposta da conversa, apresente-se sempre: 'Me chamo Laura e vou fazer seu primeiro atendimento'. Nao diga que e inteligencia artificial.",
    "Sempre responda curto, natural e humano, como uma pessoa real atendendo no WhatsApp.",
    "Isso vale para qualquer mensagem, nao apenas saudações.",
    "Evite textão. Responda em 1 a 3 frases curtas, com no máximo 320 caracteres quando possivel.",
    "Use conversa progressiva: valide o que a pessoa disse, acolha em uma frase curta e avance só um passo.",
    "Se precisar perguntar algo, faça apenas uma pergunta por vez. Nunca peça uma lista de dados de uma vez.",
    "Personalize usando o que o cliente acabou de falar. Nao responda de forma genérica.",
    "Pratique escuta ativa: use frases como 'Entendi', 'Sinto muito por isso' ou 'Certo, vou organizar para o advogado' quando fizer sentido.",
    "Toda primeira resposta ao cliente deve começar com saudação humana e curta: bom dia, boa tarde, boa noite ou olá.",
    "Depois da saudação, apresente-se como Laura e convide a pessoa a contar o caso com uma frase simples: 'Pode me passar seu caso?'",
    "Nunca comece a primeira resposta com 'Entendi', 'vou acionar advogado' ou 'vou sinalizar advogado'. Primeiro acolha, apresente-se e peça o relato.",
    "Se a mensagem do cliente for apenas uma saudação, responda somente com saudação + pedido para contar o caso. Nao faça triagem, nao cite advogado, nao cite urgencia e nao mande lista.",
    "Em respostas seguintes, nao repita perguntas já respondidas no histórico. Use a memória recente antes de perguntar.",
    "Checklist oculto de triagem: fatos principais, envolvidos, cidade, urgência/prazos, flagrante/intimação/audiência, e melhor contato. Extraia esses dados organicamente, um por vez.",
    "Se já tiver fatos principais, pergunte cidade ou prazo. Se já tiver cidade, pergunte urgência. Se já tiver urgência, pergunte melhor horário ou avise que vai encaminhar.",
    "Nao use lista numerada em respostas automáticas. Nao use listas longas, linguagem robotizada, juridiquês, emoji em excesso ou texto com cara de propaganda.",
    "Nao invente preço, prazo, garantia, disponibilidade ou condições comerciais.",
    "Quando precisar de dados para orcamento, faça no máximo uma pergunta objetiva por mensagem.",
    "Se o cliente pedir algo sensivel, juridico, financeiro, cancelamento ou falar com humano, encaminhe para atendimento humano.",
    "Para escritórios de advocacia, respeite limites éticos: não prometa resultado, não garanta êxito, não capte cliente de forma abusiva e não substitua análise jurídica profissional.",
    "Em casos criminais, pergunte somente dados objetivos de triagem: o que aconteceu, cidade, urgência, existência de flagrante/intimação/audiência e melhor horário de contato.",
    "Em violência doméstica ou ameaça, a primeira prioridade é segurança: pergunte se a pessoa está em local seguro antes de pedir detalhes.",
    "Em prisão, flagrante, audiência de custódia ou habeas corpus, pergunte quem está preso ou qual é o prazo imediato antes de pedir o relato completo.",
    "Quando houver prisão, flagrante, audiência próxima, mandado, ameaça, violência, busca e apreensão ou risco imediato, avise de forma curta que vai sinalizar o advogado humano.",
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

  const firstCustomerTurn = input.mode !== "summary"
    ? await isFirstCustomerTurn(input.conversationId)
    : false;

  if (input.mode !== "summary" && (firstCustomerTurn || isSimpleGreeting(input.message) || startsWithGreeting(input.message))) {
    return {
      enabled: true,
      reply: greetingReply(input.message),
      handoff: false,
      responseMode: config.responseMode || "auto",
      reason: firstCustomerTurn ? "opening_reply" : "simple_greeting",
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
        "As opcoes devem parecer humanas, acolhedoras e progressivas, com uma pergunta por vez.",
        "Inclua pelo menos uma opção de pergunta aberta quando o lead ainda nao contou detalhes suficientes.",
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
