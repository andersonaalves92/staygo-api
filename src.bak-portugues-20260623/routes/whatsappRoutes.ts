import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware";
import {
  connectWhatsApp,
  getWhatsAppQrCode,
  getWhatsAppSettings,
  listWhatsAppInstances,
  refreshWhatsAppStatus,
  updateWhatsAppSettings,
} from "../controllers/whatsappController";
import { requireRole } from "../middlewares/roles";

export const whatsappRoutes = Router();

whatsappRoutes.get("/settings", requireAuth, getWhatsAppSettings);
whatsappRoutes.patch("/settings", requireAuth, requireRole(["owner", "admin"]), updateWhatsAppSettings);
whatsappRoutes.get("/", requireAuth, listWhatsAppInstances);
whatsappRoutes.post("/connect", requireAuth, requireRole(["owner", "admin"]), connectWhatsApp);
whatsappRoutes.get("/:id/qr", requireAuth, requireRole(["owner", "admin"]), getWhatsAppQrCode);
whatsappRoutes.post("/:id/status", requireAuth, requireRole(["owner", "admin"]), refreshWhatsAppStatus);
