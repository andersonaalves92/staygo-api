import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware";
import { requirePlatformAdmin } from "../middlewares/roles";
import {
  blockCompany,
  createPayment,
  getCompany,
  getCompanyAdsWorkspace,
  getCompanyLeadIntelligence,
  getCompanyOperationLogs,
  getCompanyOperations,
  createCompanyOperationLog,
  validateCompanyLanding,
  getCompanyWeeklyReport,
  getBillingSummary,
  getLandingMonitor,
  getPlatformSummary,
  getServerMonitor,
  grantTrial,
  impersonateCompany,
  listCompanies,
  resetUserPassword,
  saveCompanyAdsWorkspace,
  unblockCompany,
  updateCompany,
  updateCompanyUser,
  upsertSubscription,
} from "../controllers/adminController";
import { addGoogleNegativeKeyword, discoverGoogleAccounts, getGoogleIntegration, getGoogleMetrics, getGoogleOAuthUrl, googleOAuthCallback, saveGoogleIntegration } from "../controllers/googleController";

export const adminRoutes = Router();

adminRoutes.use(requireAuth);
adminRoutes.use(requirePlatformAdmin);

adminRoutes.get("/companies", listCompanies);
adminRoutes.get("/companies/:id", getCompany);
adminRoutes.get("/companies/:id/ads-workspace", getCompanyAdsWorkspace);
adminRoutes.put("/companies/:id/ads-workspace", saveCompanyAdsWorkspace);
adminRoutes.get("/companies/:id/lead-intelligence", getCompanyLeadIntelligence);
adminRoutes.get("/companies/:id/operations", getCompanyOperations);
adminRoutes.get("/companies/:id/operation-logs", getCompanyOperationLogs);
adminRoutes.post("/companies/:id/operation-logs", createCompanyOperationLog);
adminRoutes.post("/companies/:id/validate-landing", validateCompanyLanding);
adminRoutes.get("/companies/:id/weekly-report", getCompanyWeeklyReport);
adminRoutes.get("/billing/summary", getBillingSummary);
adminRoutes.get("/platform/summary", getPlatformSummary);
adminRoutes.get("/landing-monitor", getLandingMonitor);
adminRoutes.get("/server-monitor", getServerMonitor);
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
adminRoutes.post("/google/negative-keywords", addGoogleNegativeKeyword);
