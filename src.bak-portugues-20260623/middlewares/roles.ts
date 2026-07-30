import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export function requireRole(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.role;

    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: "Sem permissao" });
    }

    next();
  };
}

export async function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.auth?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Nao autenticado" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPlatformAdmin: true },
    });

    if (!user?.isPlatformAdmin) {
      return res.status(403).json({ error: "Acesso restrito ao admin SaaS" });
    }

    next();
  } catch (error) {
    console.error("Erro requirePlatformAdmin:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
}
