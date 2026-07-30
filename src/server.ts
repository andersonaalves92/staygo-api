import "dotenv/config";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { authRoutes } from "./routes/authRoutes.js";
import { rulesRoutes } from "./routes/rulesRoutes.js";
import { leadsRoutes } from "./routes/leadsRoutes.js";
import { metricsRoutes } from "./routes/metricsRoutes.js";
import { conversationsRoutes } from "./routes/conversationsRoutes.js";
import { webhookRoutes } from "./routes/webhookRoutes.js";
import { teamRoutes } from "./routes/teamRoutes.js";
import { whatsappRoutes } from "./routes/whatsappRoutes.js";
import { adminRoutes } from "./routes/adminRoutes.js";
import { automationRoutes } from "./routes/automationRoutes.js";
import { billingRoutes } from "./routes/billingRoutes.js";
import { assistantRoutes } from "./routes/assistantRoutes.js";
import { knowledgeRoutes } from "./routes/knowledgeRoutes.js";
import { publicRoutes } from "./routes/publicRoutes.js";

import { tenantMiddleware } from "./middlewares/tenant.js";
import { requireAuth } from "./middlewares/authMiddleware.js";
import { startFollowUpScheduler } from "./lib/followups.js";
import { googleOAuthCallback } from "./controllers/googleController.js";

const app = express();

const allowedOrigins = [
  "https://app.staygobot.com",
  "https://homolog.staygobot.com",
  "https://www.kelvencriminalista.com.br",
  "https://kelvencriminalista.com.br",
  "http://localhost:5173"
];

function isAllowedOrigin(origin: string) {
  if (allowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname.endsWith(".staygobot.com");
  } catch {
    return false;
  }
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "50mb" }));
app.use(cookieParser());

//
// 🔥 TENANT PRIMEIRO
//
app.use(tenantMiddleware);

//
// 🔓 ROTAS PÚBLICAS
//
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    tenant: (req as any).tenantId
  });
});

app.use("/auth", authRoutes);
app.use("/webhooks", webhookRoutes);
app.use("/automation", automationRoutes);
app.use("/billing", billingRoutes);
app.use("/public", publicRoutes);

// Callback publica do OAuth: o Google volta sem cookie de sessao do app.
app.get("/admin/google/oauth/callback", googleOAuthCallback);

//
// 🔒 PROTEÇÃO GLOBAL (DEPOIS DAS PÚBLICAS)
//
app.use(requireAuth);

//
// 🔐 ROTAS PRIVADAS
//
app.use("/rules", rulesRoutes);
app.use("/leads", leadsRoutes);
app.use("/metrics", metricsRoutes);
app.use("/conversations", conversationsRoutes);
app.use("/team", teamRoutes);
app.use("/whatsapp", whatsappRoutes);
app.use("/admin", adminRoutes);
app.use("/assistant", assistantRoutes);
app.use("/knowledge", knowledgeRoutes);

//
// fallback
//
app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    path: req.originalUrl
  });
});

const PORT = Number(process.env.PORT) || 3333;

app.listen(PORT, "0.0.0.0", () => {
  startFollowUpScheduler();
  console.log(`🚀 API rodando na porta ${PORT}`);
});
