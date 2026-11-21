-- HTTP sources that dashboard panels read (docs/dashboards.md, "HTTP sources"). Present in every
-- edition, so the schema never diverges; only the code that reads them is Pro.
BEGIN;

CREATE TABLE "dashboard_data_sources" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "headers" JSONB NOT NULL DEFAULT '[]',
    "body" TEXT,
    "credential_ref" TEXT,
    "cache_seconds" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_data_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_data_sources_tenant_id_name_key" ON "dashboard_data_sources"("tenant_id", "name");

ALTER TABLE "dashboard_data_sources" ADD CONSTRAINT "dashboard_data_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboard_data_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_data_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_data_sources"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_data_sources" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
