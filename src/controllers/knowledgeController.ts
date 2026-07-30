import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

function getId(param: any): string {
  return Array.isArray(param) ? param[0] : param;
}

export async function listKnowledge(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const items = await prisma.knowledgeItem.findMany({
      where: { companyId },
      orderBy: [{ active: "desc" }, { category: "asc" }, { createdAt: "desc" }],
    });

    return res.json(items);
  } catch (error) {
    console.error("Erro listKnowledge:", error);
    return res.status(500).json({ error: "Erro ao listar conhecimento" });
  }
}

export async function createKnowledge(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const { title, content, category, active } = req.body || {};

    if (!title || !content) {
      return res.status(400).json({ error: "Titulo e conteudo sao obrigatorios" });
    }

    const item = await prisma.knowledgeItem.create({
      data: {
        companyId,
        title: String(title),
        content: String(content),
        category: String(category || "geral"),
        active: typeof active === "boolean" ? active : true,
      },
    });

    return res.status(201).json(item);
  } catch (error) {
    console.error("Erro createKnowledge:", error);
    return res.status(500).json({ error: "Erro ao criar conhecimento" });
  }
}

export async function updateKnowledge(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);
    const { title, content, category, active } = req.body || {};

    const result = await prisma.knowledgeItem.updateMany({
      where: { id, companyId },
      data: {
        ...(title !== undefined ? { title: String(title) } : {}),
        ...(content !== undefined ? { content: String(content) } : {}),
        ...(category !== undefined ? { category: String(category) } : {}),
        ...(typeof active === "boolean" ? { active } : {}),
      },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: "Conhecimento nao encontrado" });
    }

    const item = await prisma.knowledgeItem.findFirst({ where: { id, companyId } });
    return res.json(item);
  } catch (error) {
    console.error("Erro updateKnowledge:", error);
    return res.status(500).json({ error: "Erro ao atualizar conhecimento" });
  }
}

export async function deleteKnowledge(req: Request, res: Response) {
  try {
    const companyId = req.auth!.companyId;
    const id = getId(req.params.id);

    const result = await prisma.knowledgeItem.deleteMany({ where: { id, companyId } });

    if (result.count === 0) {
      return res.status(404).json({ error: "Conhecimento nao encontrado" });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Erro deleteKnowledge:", error);
    return res.status(500).json({ error: "Erro ao remover conhecimento" });
  }
}
