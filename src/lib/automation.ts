import { Request, Response, NextFunction } from "express";
import { prisma } from "./prisma";

export function requireAutomationToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expected = process.env.AUTOMATION_TOKEN;

  if (!expected) {
    return res.status(500).json({ error: "AUTOMATION_TOKEN nao configurado" });
  }

  const received = req.headers["x-automation-token"];
  const token = Array.isArray(received) ? received[0] : received;

  if (token !== expected) {
    return res.status(401).json({ error: "Token de automacao invalido" });
  }

  next();
}

export async function resolveCompanyIdFromInstance(instanceName: string) {
  if (!instanceName) return null;

  const instance = await prisma.whatsappInstance.findUnique({
    where: { instanceName },
    select: { companyId: true },
  });

  return instance?.companyId || null;
}

export function normalizePhone(value: string) {
  return String(value || "").replace(/\D/g, "");
}

export async function matchFaqRule(companyId: string, message: string) {
  const text = String(message || "").toLowerCase();

  if (!text) return null;

  const rules = await prisma.faqRule.findMany({
    where: { companyId, active: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });

  return (
    rules.find((rule) => {
      const trigger = rule.triggerValue.toLowerCase().trim();
      if (!trigger) return false;
      return text.includes(trigger);
    }) || null
  );
}
