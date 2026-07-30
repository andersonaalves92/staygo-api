import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware";
import { requirePlatformAdmin } from "../middlewares/roles";
import {
  blockCompany,
  createPayment,
  getCompany,
  getBillingSummary,
  getPlatformSummary,
  grantTrial,
  impersonateCompany,
  listCompanies,
  resetUserPassword,
  unblockCompany,
  updateCompany,
  updateCompanyUser,
  upsertSubscription,
} from "../controllers/adminController";
import { discoverGoogleAccounts, getGoogleIntegration, getGoogleMetrics, getGoogleOAuthUrl, googleOAuthCallback, saveGoogleIntegration } from "../controllers/googleController";

export const adminRoutes = Router();

adminRoutes.use(requireAuth);
adminRoutes.use(requirePlatformAdmin);

adminRoutes.get("/companies", listCompanies);
adminRoutes.get("/companies/:id", getCompany);
adminRoutes.get("/billing/summary", getBillingSummary);
adminRoutes.get("/platform/summary", getPlatformSummary);
adminRoutes.patch("/companies/:id", updateCompany);
adminRoutes.post("/companies/:id/impersonate", impersonateCompany);
adminRoutes.post("/companies/:id/grant-trial", grantTrial);
adminRoutes.post("/companies/:id/block", blockCompany);
adminRoutes.post("/companies/:id/unblock", unblockCompany);
adminRoutes.put("/companies/:id/subscription", upsertSubscription);
adminRoutes.post("/companies/:id/payments", createPayment);
adminRoutes.patch("/companies/:id/users/:userId", updateCompanyUser);
adminRoutes.post("/companies/:id/users/:userId/reset-password", resetUserPassword);

adminRoutes.get("/google/integration", getGoogleIntegration);
adminRoutes.put("/google/integration", saveGoogleIntegration);
adminRoutes.get("/google/oauth/url", getGoogleOAuthUrl);
adminRoutes.get("/google/oauth/callback", googleOAuthCallback);
adminRoutes.get("/google/metrics", getGoogleMetrics);
adminRoutes.get("/google/accounts", discoverGoogleAccounts);
