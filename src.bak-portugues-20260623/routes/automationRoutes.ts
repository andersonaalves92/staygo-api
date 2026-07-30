import { Router } from "express";
import { requireAutomationToken } from "../lib/automation";
import {
  assistantConfigFromAutomation,
  assistantReplyFromAutomation,
  matchRuleFromAutomation,
  runFollowUps,
  saveLeadFromAutomation,
} from "../controllers/automationController";

export const automationRoutes = Router();

automationRoutes.use(requireAutomationToken);
automationRoutes.post("/leads", saveLeadFromAutomation);
automationRoutes.post("/rules/match", matchRuleFromAutomation);
automationRoutes.post("/assistant/config", assistantConfigFromAutomation);
automationRoutes.post("/assistant/reply", assistantReplyFromAutomation);
automationRoutes.post("/followups/run", runFollowUps);
