import { Router } from "express";
import {
  matchRule,
  listRules,
  createRule,
  updateRule,
} from "../controllers/rulesController";
import { requireAuth } from "../middlewares/authMiddleware";
import { requireRole } from "../middlewares/roles";

export const rulesRoutes = Router();

rulesRoutes.use(requireAuth);

rulesRoutes.post("/match", matchRule);
rulesRoutes.get("/", listRules);
rulesRoutes.post("/", requireRole(["owner", "admin"]), createRule);
rulesRoutes.patch("/:id", requireRole(["owner", "admin"]), updateRule);
