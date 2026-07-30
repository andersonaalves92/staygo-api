import { Router } from "express";
import {
  acceptInvitation,
  createInvitation,
  createTeamMember,
  getInvitation,
  listInvitations,
  listTeam,
  getSupportAccess,
  grantSupportAccess,
  revokeSupportAccess,
  getPrivacyReport,
} from "../controllers/teamController";
import { requireAuth } from "../middlewares/authMiddleware";
import { requireRole } from "../middlewares/roles";

export const teamRoutes = Router();

teamRoutes.get("/invites/:token", getInvitation);
teamRoutes.post("/invites/:token/accept", acceptInvitation);

teamRoutes.use(requireAuth);

teamRoutes.get("/", listTeam);
teamRoutes.get("/support-access", requireRole(["owner", "admin"]), getSupportAccess);
teamRoutes.get("/privacy-report", requireRole(["owner", "admin"]), getPrivacyReport);
teamRoutes.post("/support-access", requireRole(["owner", "admin"]), grantSupportAccess);
teamRoutes.delete("/support-access", requireRole(["owner", "admin"]), revokeSupportAccess);
teamRoutes.post("/", requireRole(["owner", "admin"]), createTeamMember);
teamRoutes.get("/invites", requireRole(["owner", "admin"]), listInvitations);
teamRoutes.post("/invites", requireRole(["owner", "admin"]), createInvitation);
