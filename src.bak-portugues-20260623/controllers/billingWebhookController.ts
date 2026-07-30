import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

const paidEvents = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);
const pausedEvents = new Set([
  "PAYMENT_OVERDUE",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_REFUNDED",
  "PAYMENT_DELETED",
  "PAYMENT_BANK_SLIP_CANCELLED",
]);

function cents(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function date(value: unknown) {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function findCompanyId(payload: any) {
  const payment = payload?.payment || {};
  const subscription = payload?.subscription || {};
  const providerSubscriptionId = payment.subscription || subscription.id;
  const providerCustomerId = payment.customer || subscription.customer;

  const existingSubscription = await prisma.subscription.findFirst({
    where: {
      OR: [
        providerSubscriptionId ? { providerSubscriptionId } : undefined,
        providerCustomerId ? { providerCustomerId } : undefined,
      ].filter(Boolean) as any,
    },
    orderBy: { createdAt: "desc" },
  });

  return existingSubscription?.companyId || null;
}

export async function asaasWebhook(req: Request, res: Response) {
  try {
    const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
    const receivedToken =
      req.headers["asaas-access-token"] ||
      req.headers["x-asaas-token"] ||
      req.query.token;

    if (expectedToken && receivedToken !== expectedToken) {
      return res.status(401).json({ received: false, error: "Token invalido" });
    }

    const payload = req.body || {};
    const event = String(payload.event || "");
    const payment = payload.payment;
    const subscription = payload.subscription;
    const companyId = await findCompanyId(payload);

    if (!companyId) {
      return res.json({ received: true, ignored: true, reason: "empresa nao localizada" });
    }

    if (subscription?.id) {
      const status =
        event === "SUBSCRIPTION_DELETED" || event === "SUBSCRIPTION_INACTIVATED"
          ? "canceled"
          : "active";

      const existing = await prisma.subscription.findFirst({
        where: { companyId, providerSubscriptionId: subscription.id },
      });

      const data = {
        providerCustomerId: subscription.customer || undefined,
        providerSubscriptionId: subscription.id,
        status,
        amountCents: cents(subscription.value),
        nextDueDate: date(subscription.nextDueDate),
      };

      if (existing) {
        await prisma.subscription.update({ where: { id: existing.id }, data });
      } else {
        await prisma.subscription.create({
          data: {
            companyId,
            plan: "starter",
            ...data,
          },
        });
      }

      await prisma.company.update({
        where: { id: companyId },
        data: { status: status === "active" ? "active" : "canceled" },
      });
    }

    if (payment?.id) {
      const status = String(payment.status || event.replace("PAYMENT_", "").toLowerCase());
      const data = {
        providerPaymentId: payment.id,
        status,
        billingType: payment.billingType || undefined,
        amountCents: cents(payment.value),
        dueDate: date(payment.dueDate),
        paidAt: date(payment.paymentDate || payment.clientPaymentDate || payment.confirmedDate),
        invoiceUrl: payment.invoiceUrl || payment.bankSlipUrl || undefined,
      };

      const existingPayment = await prisma.payment.findFirst({
        where: { companyId, providerPaymentId: payment.id },
      });

      if (existingPayment) {
        await prisma.payment.update({ where: { id: existingPayment.id }, data });
      } else {
        await prisma.payment.create({ data: { companyId, ...data } });
      }

      if (paidEvents.has(event)) {
        await prisma.company.update({ where: { id: companyId }, data: { status: "active" } });
        await prisma.subscription.updateMany({
          where: {
            companyId,
            OR: [
              payment.subscription ? { providerSubscriptionId: payment.subscription } : undefined,
              payment.customer ? { providerCustomerId: payment.customer } : undefined,
            ].filter(Boolean) as any,
          },
          data: { status: "active" },
        });
      }

      if (pausedEvents.has(event)) {
        await prisma.company.update({ where: { id: companyId }, data: { status: "paused" } });
        await prisma.subscription.updateMany({
          where: {
            companyId,
            OR: [
              payment.subscription ? { providerSubscriptionId: payment.subscription } : undefined,
              payment.customer ? { providerCustomerId: payment.customer } : undefined,
            ].filter(Boolean) as any,
          },
          data: { status: "overdue" },
        });
      }
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Erro asaasWebhook:", error);
    return res.status(500).json({ received: false, error: "Erro no webhook Asaas" });
  }
}
