import { Router } from "express";
import {
  forgotPassword,
  googleLogin,
  googleLoginConfig,
  login,
  logout,
  me,
  seedOwner,
  register,
} from "../controllers/authController";
import { requireAuth } from "../middlewares/authMiddleware";
import { Request, Response, NextFunction } from "express";

function requireSeedToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.SEED_OWNER_TOKEN;
  if (!expected) return res.status(404).json({ error: "Rota nao encontrada" });
  const received = req.headers["x-seed-token"];
  const token = Array.isArray(received) ? received[0] : received;
  if (token !== expected) return res.status(404).json({ error: "Rota nao encontrada" });
  next();
}

const router = Router();

router.post("/seed-owner", requireSeedToken, seedOwner);
router.post("/login", login);
router.get("/google/config", googleLoginConfig);
router.post("/google", googleLogin);
router.post("/forgot-password", forgotPassword);
router.post("/register", register);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, me);

export { router as authRoutes };
