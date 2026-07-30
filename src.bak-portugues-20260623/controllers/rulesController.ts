import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { matchFaqRule } from "../lib/automation";

function getId(param: any): string {
  return Array.isArray(param) ? param[0] : param;
}

export async function listRules(req: Request, res: Response) {
  const companyId = req.auth!.companyId;

  const rules = await prisma.faqRule.findMany({
    where: { companyId },
  });

  return res.json(rules);
}

export async function createRule(req: Request, res: Response) {
  const companyId = req.auth!.companyId;

  const rule = await prisma.faqRule.create({
    data: {
      ...req.body,
      companyId,
    },
  });

  return res.json(rule);
}

export async function updateRule(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const id = getId(req.params.id);

  const result = await prisma.faqRule.updateMany({
    where: { id, companyId },
    data: req.body,
  });

  if (result.count === 0) {
    return res.status(404).json({ error: "Regra nao encontrada" });
  }

  const rule = await prisma.faqRule.findFirst({
    where: { id, companyId },
  });

  return res.json(rule);
}

export async function matchRule(req: Request, res: Response) {
  const companyId = req.auth!.companyId;
  const rule = await matchFaqRule(companyId, String(req.body.message || ""));

  if (!rule) {
    return res.json({ matched: false });
  }

  return res.json({
    matched: true,
    id: rule.id,
    name: rule.name,
    responseText: rule.responseText,
  });
}
