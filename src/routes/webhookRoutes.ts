import { Router } from "express";
import { evolutionWebhook, metaWebhook, metaWebhookVerify } from "../controllers/webhookController";

export const webhookRoutes = Router();

webhookRoutes.post("/evolution", evolutionWebhook);

webhookRoutes.get("/meta", metaWebhookVerify);
webhookRoutes.post("/meta", metaWebhook);
webhookRoutes.get("/whatsapp-cloud", metaWebhookVerify);
webhookRoutes.post("/whatsapp-cloud", metaWebhook);
