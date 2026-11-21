-- The messages each of an embedding app's customers started this month, against the allowance the
-- app's server states in the token it signs (docs/client-channel.md, "Allowance per customer"). One
-- row per app, customer and calendar month (UTC), counted up by the turn that admits a message.
--
-- Wrapped in a transaction on purpose: a failure between the CREATE TABLE and the FORCE ROW LEVEL
-- SECURITY below would leave a tenant-scoped table that does not bind its own owner. See
-- .claude/rules/prisma.md; there is no CONCURRENTLY here.
BEGIN;

CREATE TABLE "client_allowance_usage" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "client_app_id" BIGINT NOT NULL,
    -- Who is counted: `scope:<scope>` when the token names one (the host's organization), else
    -- `user:<sub>`. Prefixed, so a scope and a user with the same text are two customers.
    "customer" TEXT NOT NULL,
    -- The first day of the calendar month, UTC.
    "month" DATE NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_allowance_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The one read and the counter's conflict target.
CREATE UNIQUE INDEX "client_allowance_usage_client_app_id_customer_month_key" ON "client_allowance_usage"("client_app_id", "customer", "month");

-- CreateIndex
CREATE INDEX "client_allowance_usage_tenant_id_idx" ON "client_allowance_usage"("tenant_id");

-- AddForeignKey
ALTER TABLE "client_allowance_usage" ADD CONSTRAINT "client_allowance_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Gone with its app. A row per customer and month stays small, so the cascade is not batched.
ALTER TABLE "client_allowance_usage" ADD CONSTRAINT "client_allowance_usage_client_app_id_fkey" FOREIGN KEY ("client_app_id") REFERENCES "client_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the POLICY PAIR, as in 20260917180000_reply_claims_per_message.
ALTER TABLE "client_allowance_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_allowance_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "client_allowance_usage"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "client_allowance_usage" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
