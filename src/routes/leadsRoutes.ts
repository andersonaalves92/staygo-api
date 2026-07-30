import { Router } from "express";
import { createLead, exportOfflineConversions, getAdsWorkspace, getCaptureSettings, getLeadFunnel, getLeadIntelligence, listConversations, listLeads, saveAdsWorkspace, saveCaptureSettings, registerManualWhatsappHandoff, updateLeadQualification, updateLeadStage } from "../controllers/leadsController";
import { requireAuth } from "../middlewares/authMiddleware";

export const leadsRoutes = Router();
leadsRoutes.use(requireAuth);
leadsRoutes.get("/capture-settings", getCaptureSettings);
leadsRoutes.put("/capture-settings", saveCaptureSettings);
leadsRoutes.get("/ads-workspace", getAdsWorkspace);
leadsRoutes.put("/ads-workspace", saveAdsWorkspace);
leadsRoutes.post("/", createLead);
leadsRoutes.get("/", listLeads);
leadsRoutes.get("/funnel", getLeadFunnel);
leadsRoutes.get("/intelligence", getLeadIntelligence);
leadsRoutes.get("/offline-conversions.csv", exportOfflineConversions);
leadsRoutes.get("/conversations", listConversations);
leadsRoutes.patch("/:id/stage", updateLeadStage);
leadsRoutes.patch("/:id/manual-whatsapp", registerManualWhatsappHandoff);
leadsRoutes.patch("/:id/qualification", updateLeadQualification);
