import { Router } from "express";
import { createLead, exportOfflineConversions, getCaptureSettings, getLeadFunnel, getLeadIntelligence, listConversations, listLeads, saveCaptureSettings, updateLeadQualification, updateLeadStage } from "../controllers/leadsController";
import { requireAuth } from "../middlewares/authMiddleware";

export const leadsRoutes = Router();
leadsRoutes.use(requireAuth);
leadsRoutes.get("/capture-settings", getCaptureSettings);
leadsRoutes.put("/capture-settings", saveCaptureSettings);
leadsRoutes.post("/", createLead);
leadsRoutes.get("/", listLeads);
leadsRoutes.get("/funnel", getLeadFunnel);
leadsRoutes.get("/intelligence", getLeadIntelligence);
leadsRoutes.get("/offline-conversions.csv", exportOfflineConversions);
leadsRoutes.get("/conversations", listConversations);
leadsRoutes.patch("/:id/stage", updateLeadStage);
leadsRoutes.patch("/:id/qualification", updateLeadQualification);
