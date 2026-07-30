-- CreateTable
CREATE TABLE IF NOT EXISTS "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_domain_key" ON "Tenant"("domain");

-- AlterTable: add nullable first so existing production users can be backfilled.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill one tenant per existing company, using Company.id as the tenant id.
INSERT INTO "Tenant" ("id", "name", "domain", "createdAt")
SELECT
  "id",
  "name",
  lower(regexp_replace("id", '[^a-zA-Z0-9]+', '', 'g')) || '.staygobot.com',
  CURRENT_TIMESTAMP
FROM "Company"
ON CONFLICT ("id") DO NOTHING;

-- Fallback tenant for any legacy user without a membership.
INSERT INTO "Tenant" ("id", "name", "domain", "createdAt")
VALUES ('tenant-default', 'StayGoBot', 'default.staygobot.com', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

UPDATE "User" u
SET "tenantId" = COALESCE(
  (
    SELECT m."companyId"
    FROM "Membership" m
    WHERE m."userId" = u."id"
    ORDER BY m."createdAt" ASC
    LIMIT 1
  ),
  'tenant-default'
)
WHERE u."tenantId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "tenantId" SET NOT NULL;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_tenantId_fkey'
  ) THEN
    ALTER TABLE "User"
    ADD CONSTRAINT "User_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
