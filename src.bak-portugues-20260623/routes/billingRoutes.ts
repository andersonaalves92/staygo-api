import { Router } from "express";
import { asaasWebhook } from "../controllers/billingWebhookController";

export const billingRoutes = Router();

billingRoutes.post("/asaas/webhook", asaasWebhook);
