import { Router } from "express";
import { requireAuth } from "../middlewares/authMiddleware";
import {
  seedConversations,
  listStages,
  listConversations,
  getConversationById,
  sendMessage,
  suggestConversationReply,
  suggestQuickReplies,
  summarizeConversation,
  updateConversation,
  archiveConversation,
} from "../controllers/conversationsController";

export const conversationsRoutes = Router();

conversationsRoutes.use(requireAuth);

conversationsRoutes.post("/seed", seedConversations);
conversationsRoutes.get("/stages", listStages);
conversationsRoutes.get("/", listConversations);
conversationsRoutes.get("/:id", getConversationById);
conversationsRoutes.post("/:id/suggest-reply", suggestConversationReply);
conversationsRoutes.post("/:id/quick-replies", suggestQuickReplies);
conversationsRoutes.post("/:id/summary", summarizeConversation);
conversationsRoutes.post("/:id/messages", sendMessage);
conversationsRoutes.patch("/:id", updateConversation);
conversationsRoutes.delete("/:id", archiveConversation);
