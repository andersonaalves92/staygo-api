import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../lib/jwt";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.session_token;

  if (!token) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  try {
    const payload = verifySessionToken(token);

    req.auth = payload;

    if (req.tenantId && payload.tenantId && req.tenantId !== payload.tenantId) {
      return res.status(403).json({ error: "Tenant da sessao invalido" });
    }

    next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida" });
  }
}
