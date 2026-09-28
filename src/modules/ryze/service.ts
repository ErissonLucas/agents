import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  removeChatwootInstance,
  syncInboxes,
} from "@/modules/chatwoot/management";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import {
  createRyzeClient,
  RyzeApiError,
  type RyzeClient,
  type RyzeClientConfig,
} from "./client";
import { RYZE_EMULATOR_ROOT, RYZE_WEBHOOK_MOUNT } from "./constants";

// The operator-facing half of the RyzeAPI channel: connecting a number creates an account of kind
// RYZE (under the tenant's deployment, or a placeholder one when the tenant has no Chatwoot), the
// gateway row that authenticates Ryze's webhooks, and the inbox mirror; from there the number is
// bound to an agent with the same `bindInbox` every Chatwoot inbox uses.

export interface RyzeServiceDeps {
  makeRyzeClient?: (cfg: RyzeClientConfig) => Promise<RyzeClient>;
}

export interface RyzeGatewayView {
  instanceId: string;
  name: string;
  instanceName: string;
  baseUrl: string;
  inboxId: number;
  connectionState: string | null;
  numberJid: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

function requireTenant(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

export function ryzeWebhookUrl(publicUrl: string, routeToken: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${RYZE_WEBHOOK_MOUNT}/${routeToken}`;
}

function describe(err: unknown): string {
  if (err instanceof RyzeApiError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

// The question a connect asks before writing anything: the token opens this instance. Asked by the
// MCP preview too, so a preview never approves a connect the apply would refuse.
export async function assertRyzeConnectable(
  cfg: RyzeClientConfig,
  deps: RyzeServiceDeps = {},
): Promise<{
  ryze: RyzeClient;
  state: Awaited<ReturnType<RyzeClient["connectionState"]>>;
}> {
  const make = deps.makeRyzeClient ?? ((c) => createRyzeClient(c));
  try {
    const ryze = await make(cfg);
    return { ryze, state: await ryze.connectionState() };
  } catch (err) {
    const detail = describe(err);
    throw new AppError(
      `could not reach the RyzeAPI instance: ${detail}`,
      400,
      "errors.ryzeConnectFailed",
      { detail },
    );
  }
}

export async function connectRyzeGateway(
  ctx: TenantContext,
  input: { name: string; baseUrl: string; instanceName: string; token: string },
  deps: RyzeServiceDeps = {},
  base: PrismaClient = basePrisma,
): Promise<RyzeGatewayView> {
  const tenantId = requireTenant(ctx);
  const cfg: RyzeClientConfig = {
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    instance: input.instanceName,
    token: input.token,
  };
  const { ryze, state } = await assertRyzeConnectable(cfg, deps);

  const { token: routeToken, hash: routeTokenHash } = generateRouteToken();
  const authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  const created = await runScopedOn(base, ctx, async (db) => {
    const deployment =
      (await db.chatwootDeployment.findFirst({ select: { id: true } })) ??
      (await db.chatwootDeployment.create({
        data: {
          tenantId,
          baseUrl: RYZE_EMULATOR_ROOT,
          adminToken: encryptJson(randomBytes(24).toString("base64url")),
        },
        select: { id: true },
      }));
    const seq = await db.$queryRaw<Array<{ next: number }>>`
      SELECT nextval('ryze_emulated_id_seq')::int AS next`;
    const next = seq[0]?.next;
    if (next === undefined) throw new AppError("ryze id sequence empty", 500);
    const instance = await db.chatwootInstance.create({
      data: {
        tenantId,
        deploymentId: deployment.id,
        accountId: next,
        serverKey: `ryze:${randomUUID()}`,
        accountName: input.name,
        kind: "RYZE",
      },
    });
    const gateway = await db.ryzeGateway.create({
      data: {
        tenantId,
        chatwootInstanceId: instance.id,
        baseUrl: cfg.baseUrl,
        instanceName: cfg.instance,
        token: encryptJson(cfg.token),
        webhookAuth: encryptJson(authorization),
        webhookRouteTokenHash: routeTokenHash,
        inboxName: input.name,
        connectionState: state.state,
        numberJid: state.numberJid,
      },
    });
    return { instance, gateway };
  });

  try {
    await ryze.configureWebhook({
      url: ryzeWebhookUrl(config.publicUrl, routeToken),
      authorization,
    });
    await syncInboxes(ctx, created.instance.id, {}, base);
  } catch (err) {
    await runScopedOn(base, ctx, (db) =>
      db.chatwootInstance.delete({ where: { id: created.instance.id } }),
    ).catch(() => {});
    const detail = describe(err);
    throw new AppError(
      `could not reach the RyzeAPI instance: ${detail}`,
      400,
      "errors.ryzeConnectFailed",
      { detail },
    );
  }
  logger.info(
    "ryze: connected instance %s as account %s (tenant %s)",
    cfg.instance,
    String(created.instance.id),
    String(tenantId),
  );
  return viewOf(created.gateway, input.name);
}

function viewOf(
  gw: {
    chatwootInstanceId: bigint;
    instanceName: string;
    baseUrl: string;
    inboxId: number;
    inboxName: string;
    connectionState: string | null;
    numberJid: string | null;
    lastEventAt: Date | null;
    createdAt: Date;
  },
  name?: string,
): RyzeGatewayView {
  return {
    instanceId: String(gw.chatwootInstanceId),
    name: name ?? gw.inboxName,
    instanceName: gw.instanceName,
    baseUrl: gw.baseUrl,
    inboxId: gw.inboxId,
    connectionState: gw.connectionState,
    numberJid: gw.numberJid,
    lastEventAt: gw.lastEventAt?.toISOString() ?? null,
    createdAt: gw.createdAt.toISOString(),
  };
}

export async function listRyzeGateways(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<RyzeGatewayView[]> {
  requireTenant(ctx);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.ryzeGateway.findMany({ orderBy: { createdAt: "asc" } }),
  );
  return rows.map((r) => viewOf(r));
}

export async function getRyzeGateway(
  ctx: TenantContext,
  instanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<RyzeGatewayView> {
  return viewOf(await gatewayOrThrow(ctx, instanceId, base));
}

async function gatewayOrThrow(
  ctx: TenantContext,
  instanceId: bigint,
  base: PrismaClient,
) {
  const gw = await runScopedOn(base, ctx, (db) =>
    db.ryzeGateway.findUnique({ where: { chatwootInstanceId: instanceId } }),
  );
  if (!gw) {
    throw new NotFoundError(
      "ryze gateway not found",
      "errors.ryzeGatewayNotFound",
    );
  }
  return gw;
}

// Asks RyzeAPI for the live connection state and stores it.
export async function refreshRyzeGateway(
  ctx: TenantContext,
  instanceId: bigint,
  deps: RyzeServiceDeps = {},
  base: PrismaClient = basePrisma,
): Promise<RyzeGatewayView> {
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  const make = deps.makeRyzeClient ?? ((c) => createRyzeClient(c));
  const ryze = await make({
    baseUrl: gw.baseUrl,
    instance: gw.instanceName,
    token: decryptJson<string>(gw.token),
  });
  const state = await ryze.connectionState();
  const updated = await runScopedOn(base, ctx, (db) =>
    db.ryzeGateway.update({
      where: { id: gw.id },
      data: {
        connectionState: state.state,
        ...(state.numberJid ? { numberJid: state.numberJid } : {}),
      },
    }),
  );
  return viewOf(updated);
}

// Stops Ryze delivering to us (best effort) and removes the account with everything under it,
// through the same removal a Chatwoot account goes through (agents unbound, rows cascaded).
export async function removeRyzeGateway(
  ctx: TenantContext,
  instanceId: bigint,
  deps: RyzeServiceDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  try {
    const make = deps.makeRyzeClient ?? ((c) => createRyzeClient(c));
    const ryze = await make({
      baseUrl: gw.baseUrl,
      instance: gw.instanceName,
      token: decryptJson<string>(gw.token),
    });
    await ryze.disableWebhook();
  } catch (err) {
    logger.warn(
      "ryze: could not disable the webhook of %s: %s",
      gw.instanceName,
      describe(err),
    );
  }
  await removeChatwootInstance(ctx, instanceId, base);
}
