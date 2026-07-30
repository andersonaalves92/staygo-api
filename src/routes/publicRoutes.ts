import { Router } from "express";
import { createPublicLead, getPublicCaptureConfig } from "../controllers/leadsController";

export const publicRoutes = Router();
publicRoutes.get("/capture/:slug", getPublicCaptureConfig);
publicRoutes.post("/capture/:slug/leads", createPublicLead);
