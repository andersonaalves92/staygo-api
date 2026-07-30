import { Router } from "express";
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
} from "../controllers/knowledgeController";
import { requireRole } from "../middlewares/roles";

export const knowledgeRoutes = Router();

knowledgeRoutes.get("/", listKnowledge);
knowledgeRoutes.post("/", requireRole(["owner", "admin"]), createKnowledge);
knowledgeRoutes.patch("/:id", requireRole(["owner", "admin"]), updateKnowledge);
knowledgeRoutes.delete("/:id", requireRole(["owner", "admin"]), deleteKnowledge);
