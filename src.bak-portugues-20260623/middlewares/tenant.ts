import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    let tenantId: string | null = null;

    //
    // 1️⃣ PRIORIDADE: HEADER (DEV / fallback)
    //
    const headerTenant = req.headers["x-tenant-id"] as string;
    if (headerTenant) {
      tenantId = headerTenant;
    }

    //
    // 2️⃣ SUBDOMÍNIO (PRODUÇÃO)
    //
    if (!tenantId) {
      const host = req.headers.host; // empresa1.staygobot.com

      if (host) {
        const hostname = host.split(":")[0];
        const genericHosts = new Set([
          "app.staygobot.com",
          "homolog.staygobot.com",
          "backend.staygobot.com",
          "staygobot.com",
          "www.staygobot.com",
          "localhost",
          "127.0.0.1",
        ]);

        if (genericHosts.has(hostname)) {
          return next();
        }

        const parts = hostname.split(".");
        if (parts.length >= 3) {
          const subdomain = parts[0];

          const tenant = await prisma.tenant.findUnique({
            where: { domain: `${subdomain}.staygobot.com` },
          });

          if (tenant) {
            tenantId = tenant.id;
          }
        }
      }
    }

    //
    // ❌ NÃO ENCONTROU
    //
    if (!tenantId) {
      return res.status(400).json({
        error: "Tenant não identificado",
      });
    }

    //
    // 💾 injeta no request
    //
    req.tenantId = tenantId;

    next();
  } catch (error) {
    console.error("Erro tenantMiddleware:", error);
    return res.status(500).json({
      error: "Erro interno tenant",
    });
  }
}
