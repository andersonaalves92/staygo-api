import { Request } from "express";

export interface AuthPayload {
  userId: string;
  tenantId: string;
  companyId: string;
  role: string;
  supportAccess?: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthPayload;
    tenantId?: string;
  }
}
