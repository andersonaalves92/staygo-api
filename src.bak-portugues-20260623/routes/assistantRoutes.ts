import { Router } from "express";
import {
  getAssistantSettings,
  testAssistant,
  updateAssistantSettings,
} from "../controllers/assistantController";
import { requireRole } from "../middlewares/roles";

export const assistantRoutes = Router();

assistantRoutes.get("/", getAssistantSettings);
assistantRoutes.patch("/", requireRole(["owner", "admin"]), updateAssistantSettings);
assistantRoutes.post("/test", testAssistant);
