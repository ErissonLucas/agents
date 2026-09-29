-- WhatsApp Business labels for RyzeAPI numbers: the per-number catalog, whether the number answers
-- label calls at all, and the titles the team moved on the phone (which the agent leaves alone).
--
-- Wrapped in a transaction: a failure between the CREATE TABLE and the FORCE ROW LEVEL SECURITY
-- below would leave a tenant-scoped table that does not bind its own owner. No CONCURRENTLY here.
BEGIN;

-- AlterTable
ALTER TABLE "ryze_gateways" ADD COLUMN "labels_supported" BOOLEAN,
ADD COLUMN "labels_checked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ryze_conversations" ADD COLUMN "device_labels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ryze_labels" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "display_name" TEXT,
    "color" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "auto_rule" TEXT,
    "tag_id" TEXT,
    "origin" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_labels_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ryze_labels_color_check" CHECK ("color" BETWEEN 0 AND 10),
    CONSTRAINT "ryze_labels_origin_check" CHECK ("origin" IN ('fazerai', 'device'))
);

-- CreateIndex
CREATE INDEX "ryze_labels_tenant_id_idx" ON "ryze_labels"("tenant_id");

-- CreateIndex
CREATE INDEX "ryze_labels_gateway_id_idx" ON "ryze_labels"("gateway_id");

-- One live label per title (case-insensitive) and per WhatsApp id on a number; a deleted row keeps
-- its title out of the way. Partial indexes, so they live only here and not in schema.prisma.
CREATE UNIQUE INDEX "ryze_labels_gateway_id_title_live_key" ON "ryze_labels"("gateway_id", lower("title")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "ryze_labels_gateway_id_tag_id_live_key" ON "ryze_labels"("gateway_id", "tag_id") WHERE "deleted_at" IS NULL AND "tag_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "ryze_labels" ADD CONSTRAINT "ryze_labels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_labels" ADD CONSTRAINT "ryze_labels_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (tests/lib/rls-policy-shape.test.ts).
ALTER TABLE "ryze_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_labels" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ryze_labels"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_labels" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
