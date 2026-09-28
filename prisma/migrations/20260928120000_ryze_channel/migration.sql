-- RyzeAPI as a second channel: an account of kind RYZE whose Chatwoot API is emulated over the
-- tables below (src/modules/ryze). Wrapped in a transaction because a failure between a CREATE TABLE
-- and its FORCE ROW LEVEL SECURITY would leave a tenant-scoped table that does not bind its owner.
BEGIN;

-- Emulated Chatwoot ids start far above any real Chatwoot id, so a tenant with a real account and a
-- Ryze one never sees the same inbox, conversation or message id twice.
CREATE SEQUENCE "ryze_emulated_id_seq" AS INTEGER START WITH 1500000000;

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('CHATWOOT', 'RYZE');

-- AlterTable
ALTER TABLE "chatwoot_instances" ADD COLUMN     "kind" "ChannelKind" NOT NULL DEFAULT 'CHATWOOT';

-- CreateTable
CREATE TABLE "ryze_gateways" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "chatwoot_instance_id" BIGINT NOT NULL,
    "base_url" TEXT NOT NULL,
    "instance_name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "webhook_auth" TEXT NOT NULL,
    "webhook_route_token_hash" TEXT NOT NULL,
    "inbox_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "inbox_name" TEXT NOT NULL,
    "agent_bot_id" INTEGER,
    "observer_bot_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "connection_state" TEXT,
    "number_jid" TEXT,
    "last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ryze_bots" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "bot_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "name" TEXT NOT NULL,
    "outgoing_url" TEXT,
    "access_token" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ryze_contacts" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "contact_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "identifier" TEXT,
    "custom_attributes" JSONB NOT NULL DEFAULT '{}',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ryze_conversations" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "display_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "contact_inbox_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "contact_id" INTEGER NOT NULL,
    "chat_jid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignee_type" TEXT,
    "assignee_id" INTEGER,
    "assignee_name" TEXT,
    "team_id" INTEGER,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom_attributes" JSONB NOT NULL DEFAULT '{}',
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ryze_messages" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "message_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "message_type" INTEGER NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT,
    "content_attributes" JSONB NOT NULL DEFAULT '{}',
    "sender_type" TEXT,
    "sender_id" INTEGER,
    "sender_name" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ryze_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ryze_media" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "gateway_id" BIGINT NOT NULL,
    "attachment_id" INTEGER NOT NULL DEFAULT nextval('ryze_emulated_id_seq'),
    "message_id" INTEGER NOT NULL,
    "file_type" TEXT NOT NULL,
    "mime" TEXT,
    "file_name" TEXT,
    "bytes" BYTEA,
    "external_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ryze_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ryze_gateways_chatwoot_instance_id_key" ON "ryze_gateways"("chatwoot_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_gateways_webhook_route_token_hash_key" ON "ryze_gateways"("webhook_route_token_hash");

-- CreateIndex
CREATE INDEX "ryze_gateways_tenant_id_idx" ON "ryze_gateways"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_bots_bot_id_key" ON "ryze_bots"("bot_id");

-- CreateIndex
CREATE INDEX "ryze_bots_tenant_id_idx" ON "ryze_bots"("tenant_id");

-- CreateIndex
CREATE INDEX "ryze_bots_gateway_id_idx" ON "ryze_bots"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_contacts_contact_id_key" ON "ryze_contacts"("contact_id");

-- CreateIndex
CREATE INDEX "ryze_contacts_tenant_id_idx" ON "ryze_contacts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_contacts_gateway_id_jid_key" ON "ryze_contacts"("gateway_id", "jid");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_conversations_display_id_key" ON "ryze_conversations"("display_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_conversations_contact_inbox_id_key" ON "ryze_conversations"("contact_inbox_id");

-- CreateIndex
CREATE INDEX "ryze_conversations_tenant_id_idx" ON "ryze_conversations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_conversations_gateway_id_chat_jid_key" ON "ryze_conversations"("gateway_id", "chat_jid");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_messages_message_id_key" ON "ryze_messages"("message_id");

-- CreateIndex
CREATE INDEX "ryze_messages_gateway_id_conversation_id_message_id_idx" ON "ryze_messages"("gateway_id", "conversation_id", "message_id");

-- CreateIndex
CREATE INDEX "ryze_messages_tenant_id_idx" ON "ryze_messages"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_messages_gateway_id_external_id_key" ON "ryze_messages"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "ryze_media_attachment_id_key" ON "ryze_media"("attachment_id");

-- CreateIndex
CREATE INDEX "ryze_media_gateway_id_message_id_idx" ON "ryze_media"("gateway_id", "message_id");

-- CreateIndex
CREATE INDEX "ryze_media_tenant_id_idx" ON "ryze_media"("tenant_id");

-- AddForeignKey
ALTER TABLE "ryze_gateways" ADD CONSTRAINT "ryze_gateways_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_gateways" ADD CONSTRAINT "ryze_gateways_chatwoot_instance_id_fkey" FOREIGN KEY ("chatwoot_instance_id") REFERENCES "chatwoot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_bots" ADD CONSTRAINT "ryze_bots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_bots" ADD CONSTRAINT "ryze_bots_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_contacts" ADD CONSTRAINT "ryze_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_contacts" ADD CONSTRAINT "ryze_contacts_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_conversations" ADD CONSTRAINT "ryze_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_conversations" ADD CONSTRAINT "ryze_conversations_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_messages" ADD CONSTRAINT "ryze_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_messages" ADD CONSTRAINT "ryze_messages_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_media" ADD CONSTRAINT "ryze_media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ryze_media" ADD CONSTRAINT "ryze_media_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "ryze_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ryze_gateways" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_gateways" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ryze_bots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_bots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ryze_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_contacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ryze_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_conversations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ryze_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ryze_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ryze_media" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ryze_gateways"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ryze_bots"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ryze_contacts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ryze_conversations"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ryze_messages"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "ryze_media"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_gateways" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_bots" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_contacts" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_conversations" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_messages" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "ryze_media" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
