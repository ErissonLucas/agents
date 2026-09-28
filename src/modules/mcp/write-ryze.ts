import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import {
  assertRyzeConnectable,
  connectRyzeGateway,
  getRyzeGateway,
  listRyzeGateways,
  refreshRyzeGateway,
  removeRyzeGateway,
} from "@/modules/ryze/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  err,
  gate,
  ok,
  parseMcpId,
  readGate,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP tools for the RyzeAPI channel: list, connect, refresh and remove WhatsApp numbers served
// through RyzeAPI. The instance token is passed raw to ryze_connect (the operator holds it), used
// in-band and stored encrypted; it is never returned. Each preview asks what its apply asks.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

export async function ryzeList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  return ok({ gateways: await listRyzeGateways(ctx, deps.base ?? basePrisma) });
}

export interface RyzeConnectArgs {
  name: string;
  base_url: string;
  instance_name: string;
  token: string;
  dry_run?: boolean;
}

export async function ryzeConnect(
  principal: VerifiedToken,
  args: RyzeConnectArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.token) return err("token is required");
  const input = {
    name: args.name,
    baseUrl: args.base_url,
    instanceName: args.instance_name,
    token: args.token,
  };
  try {
    if (args.dry_run !== false) {
      const { state } = await assertRyzeConnectable({
        baseUrl: input.baseUrl,
        instance: input.instanceName,
        token: input.token,
      });
      return ok({
        dryRun: true,
        action: "connect",
        name: input.name,
        instanceName: input.instanceName,
        connectionState: state.state,
        numberJid: state.numberJid,
        note: "Registers this server's webhook on the instance and creates the inbox; bind it with inbox_bind.",
      });
    }
    const gateway = await connectRyzeGateway(
      ctx,
      input,
      {},
      deps.base ?? basePrisma,
    );
    return ok({ dryRun: false, applied: true, gateway });
  } catch (e) {
    return failOf(e);
  }
}

export async function ryzeRefresh(
  principal: VerifiedToken,
  args: { instance_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.instance_id, "instance_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({
      gateway: await refreshRyzeGateway(ctx, id, {}, deps.base ?? basePrisma),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function ryzeRemove(
  principal: VerifiedToken,
  args: { instance_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.instance_id, "instance_id");
  if (typeof id !== "bigint") return id;
  try {
    if (args.dry_run !== false) {
      const gateway = await getRyzeGateway(ctx, id, base);
      return ok({
        dryRun: true,
        action: "remove",
        target: `instance:${id}`,
        gateway,
        note: "Disables this server's webhook on RyzeAPI and deletes the number with its conversations.",
      });
    }
    await removeRyzeGateway(ctx, id, {}, base);
    return ok({ dryRun: false, applied: true, removed: String(id) });
  } catch (e) {
    return failOf(e);
  }
}
