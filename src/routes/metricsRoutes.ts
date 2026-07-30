import { Router } from "express";
import { getDashboardMetrics, getOnboardingStatus } from "../controllers/metricsController";
import { requireAuth } from "../middlewares/authMiddleware";

export const metricsRoutes = Router();

metricsRoutes.use(requireAuth);

metricsRoutes.get("/dashboard", getDashboardMetrics);
metricsRoutes.get("/onboarding", getOnboardingStatus);
