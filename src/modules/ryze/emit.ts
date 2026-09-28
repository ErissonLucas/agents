import { createHmac, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  CHATWOOT_DELIVERY_HEADER,
  CHATWOOT_SIGNATURE_HEADER,
  CHATWOOT_TIMESTAMP_HEADER,
} from "@/modules/chatwoot/signing";
import { CHATWOOT_WEBHOOK_MOUNT } from "@/modules/chatwoot/webhook-mount";

// Delivers emulated Agent Bot webhooks the way Chatwoot does: the raw JSON body, a fresh delivery
// UUID, and `sha256=HMAC(secret, "{ts}.{body}")`, to the inbox's answering bot and every observer.
// A bot whose outgoing_url is our own receiver is dispatched in-process (same two calls the
// controller makes); any other URL is POSTed. Deliveries per gateway run in order, detached from the
// request that produced them, which is also when Chatwoot sends them: after its own write commits.

export interface SignedDelivery {
  url: string;
  rawBody: string;
  headers: Record<string, string>;
}

export type BotDeliverer = (d: SignedDelivery) => Promise<void>;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function signDelivery(
  url: string,
  secret: string,
  payload: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignedDelivery {
  const rawBody = JSON.stringify(payload);
  const ts = String(nowSeconds);
  const sig = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return {
    url,
    rawBody,
    headers: {
      [CHATWOOT_DELIVERY_HEADER]: randomUUID(),
      [CHATWOOT_TIMESTAMP_HEADER]: ts,
      [CHATWOOT_SIGNATURE_HEADER]: `sha256=${sig}`,
      "content-type": "application/json",
    },
  };
}

function inProcessRouteToken(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const prefix = `${CHATWOOT_WEBHOOK_MOUNT}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

export const defaultBotDeliverer: BotDeliverer = async (d) => {
  const routeToken = inProcessRouteToken(d.url);
  if (routeToken === null) {
    await fetch(d.url, {
      method: "POST",
      headers: d.headers,
      body: d.rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    return;
  }
  const { receiveChatwootWebhook, recordAndProcessChatwootDelivery } =
    await import("@/modules/chatwoot/webhook");
  const result = await receiveChatwootWebhook({
    routeToken,
    rawBody: d.rawBody,
    getHeader: (name) => d.headers[name.toLowerCase()] ?? null,
  });
  if (
    result.outcome === "queued" &&
    result.tenantId !== undefined &&
    result.instanceId !== undefined &&
    result.deliveryId !== undefined &&
    result.normalized !== undefined
  ) {
    void recordAndProcessChatwootDelivery({
      tenantId: result.tenantId,
      instanceId: result.instanceId,
      deliveryId: result.deliveryId,
      agentBotId: result.agentBotId ?? null,
      normalized: result.normalized,
    }).catch((err) => {
      logger.error(
        "ryze: async dispatch failed (delivery %s): %s",
        result.deliveryId,
        err instanceof Error ? err.message : String(err),
      );
    });
  }
};

let deliverer: BotDeliverer = defaultBotDeliverer;

// NOTE: test seam; returns the previous deliverer so a test can restore it.
export function setBotDeliverer(next: BotDeliverer): BotDeliverer {
  const prev = deliverer;
  deliverer = next;
  return prev;
}

export interface EmitTarget {
  tenantId: bigint;
  gatewayId: bigint;
  base?: PrismaClient;
}

async function botsFor(
  target: EmitTarget,
): Promise<Array<{ url: string; secret: string }>> {
  const base = target.base ?? basePrisma;
  return runScopedOn(base, sysCtx(target.tenantId), async (db) => {
    const gw = await db.ryzeGateway.findUnique({
      where: { id: target.gatewayId },
      select: { agentBotId: true, observerBotIds: true },
    });
    if (!gw) return [];
    const ids = [
      ...(gw.agentBotId !== null ? [gw.agentBotId] : []),
      ...gw.observerBotIds,
    ];
    if (ids.length === 0) return [];
    const bots = await db.ryzeBot.findMany({
      where: { gatewayId: target.gatewayId, botId: { in: ids } },
      select: { outgoingUrl: true, secret: true },
    });
    return bots
      .filter((b) => b.outgoingUrl)
      .map((b) => ({
        url: b.outgoingUrl as string,
        secret: decryptJson<string>(b.secret),
      }));
  });
}

// Queues the payloads for this gateway's bots, in order, and returns without waiting for delivery.
export function emitToBots(target: EmitTarget, payloads: unknown[]): void {
  if (payloads.length === 0) return;
  void withKeyedQueue(`ryze-emit:${target.gatewayId}`, async () => {
    const bots = await botsFor(target);
    for (const payload of payloads) {
      for (const bot of bots) {
        try {
          await deliverer(signDelivery(bot.url, bot.secret, payload));
        } catch (err) {
          logger.warn(
            "ryze: bot delivery failed (gateway %s): %s",
            String(target.gatewayId),
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }).catch((err) => {
    logger.error(
      "ryze: emit queue failed (gateway %s): %s",
      String(target.gatewayId),
      err instanceof Error ? err.message : String(err),
    );
  });
}

// Resolves once every emission queued so far for this gateway has been delivered (tests, shutdown).
export function drainEmits(gatewayId: bigint): Promise<void> {
  return withKeyedQueue(`ryze-emit:${gatewayId}`, async () => {});
}
