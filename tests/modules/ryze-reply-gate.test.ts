import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ChatwootApiError } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { bindInbox } from "@/modules/chatwoot/management";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { RyzeClient } from "@/modules/ryze/client";
import { drainEmits, setBotDeliverer } from "@/modules/ryze/emit";
import { RyzeEmulator, setRyzeClientFactory } from "@/modules/ryze/emulator";
import { drainLabelSyncs } from "@/modules/ryze/labels";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import { connectRyzeGateway } from "@/modules/ryze/service";
import { flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// THE REPLY GATE ON A RYZEAPI NUMBER (docs/LIVARE-F21-PORTAO-ETIQUETA.md), end to end: the real
// receiver, emulator, webhook, runtime, split loop and nudge against the test database. Only
// RyzeAPI's HTTP and the model are faked, and the fake records every send the provider was asked to
// make, which is the one fact the customer's phone depends on.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const SEND_PATHS = [
  "/api/message/text",
  "/api/message/media",
  "/api/message/button",
  "/api/message/carousel",
  "/api/message/reaction",
];
const sends: { path: string; text: string }[] = [];
const tagCalls: { method: string; body: string }[] = [];
let onSend: (() => Promise<void>) | null = null;
const hook = { url: "", auth: "" };
let n = 0;

function fakeRyze(): RyzeClient {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (url.pathname.startsWith("/api/events/webhook")) {
      hook.url = String(body.url);
      hook.auth = String(body.authorization);
    }
    if (url.pathname.startsWith("/api/instance/list")) {
      return Response.json({
        success: true,
        instances: [
          {
            name: "portao",
            status: "connected",
            connection: {
              state: "connected",
              numberJid: "5581900000077@s.whatsapp.net",
            },
            profile: { name: "Portao" },
          },
        ],
      });
    }
    if (url.pathname.startsWith("/api/chat/assignTag")) {
      tagCalls.push({
        method: init?.method ?? "GET",
        body: raw || url.search,
      });
      return Response.json({ success: true, data: {} });
    }
    if (url.pathname.startsWith("/api/chat/tag")) {
      return Response.json({ success: true, tags: [] });
    }
    const send = SEND_PATHS.find((p) => url.pathname.startsWith(p));
    if (send) {
      n += 1;
      sends.push({
        path: send,
        text: String(body.message ?? body.caption ?? body.text ?? ""),
      });
      if (onSend) await onSend();
      return Response.json({
        success: true,
        data: { messageId: `PROV${n}`, timestamp: new Date().toISOString() },
      });
    }
    return Response.json({ success: true, data: {} });
  }) as typeof fetch;
  return new RyzeClient(
    { baseUrl: outboundUrl("/"), instance: "portao", token: "tok" },
    fetchImpl,
  );
}

let tenantId = 0n;
let instanceId = 0n;
let gatewayId = 0n;
let agentId = 0n;
let botToken = "";
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const noSleep = async () => {};
const TWO_BALLOONS = "Primeiro balão.\n\nSegundo balão.";
const REQUIRED = "ia-atendendo";
const HANDOFF = "com-vendedor";

let processing = false;
let processDeps: RuntimeDeps = {};

async function setSettings(extra: Record<string, unknown>) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: {
        debounce: { enabled: false },
        split: { enabled: true },
        ...extra,
      } as Prisma.InputJsonValue,
    },
  });
}
const gateOn = (more: Record<string, unknown> = {}) => ({
  replyGate: {
    enabled: true,
    requiredLabel: REQUIRED,
    handoffLabel: HANDOFF,
    ...more,
  },
});

let jidSeq = 0;
let msgSeq = 0;
const newJid = () => {
  jidSeq += 1;
  return `5581966${String(jidSeq).padStart(6, "0")}`;
};
async function inbound(jid: string, text: string): Promise<number> {
  msgSeq += 1;
  const res = await receiveRyzeWebhook({
    routeToken: hook.url.split("/").pop() as string,
    authorization: hook.auth,
    base: appDb,
    rawBody: JSON.stringify({
      event: "message.exchange",
      data: {
        message: {
          id: `GATE-${process.pid}-${msgSeq}`,
          direction: "incoming",
          timestamp: new Date().toISOString(),
          chat: { jid, name: "Cliente", type: "private" },
          sender: { jid, name: "Cliente" },
          content: { text },
        },
      },
    }),
  });
  expect(res.outcome).toBe("accepted");
  await drainEmits(gatewayId);
  const conv = await suDb.ryzeConversation.findFirstOrThrow({
    where: { gatewayId, chatJid: `${jid}@s.whatsapp.net` },
  });
  return conv.displayId;
}
// A conversation that exists before the scenario starts, opened without running any turn. With
// `mirrored`, the delivery is processed too (under a closed gate, so nothing is answered), which is
// what writes the mirror row a proactive nudge needs.
async function openConversation(
  mirrored = false,
): Promise<{ jid: string; cid: number }> {
  const jid = newJid();
  processing = mirrored;
  if (mirrored) replyWith("Não devia sair.");
  const cid = await inbound(jid, "primeira mensagem");
  processing = false;
  return { jid, cid };
}
async function setLabels(cid: number, labels: string[]) {
  await suDb.ryzeConversation.update({
    where: { displayId: cid },
    data: { labels },
  });
}
async function labelsOf(cid: number): Promise<string[]> {
  return (
    await suDb.ryzeConversation.findUniqueOrThrow({ where: { displayId: cid } })
  ).labels;
}
async function catalog(title: string, tagId: string | null) {
  await suDb.ryzeLabel.create({
    data: { tenantId, gatewayId, title, origin: "fazerai", tagId },
  });
}
async function gateLines(cid: number): Promise<Record<string, unknown>[]> {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { chatwootInstanceId: instanceId, chatwootConversationId: cid },
    select: { id: true },
  });
  const rows = await flowLogRows(suDb, {
    where: { conversationId: conv.id, stage: "handoff" },
    orderBy: { id: "asc" },
  });
  return rows
    .map((r) => r.detail as Record<string, unknown>)
    .filter((d) => d?.outcome === "reply_gate_closed");
}
async function client() {
  return loadChatwootClient(tenantId, instanceId, { base: appDb, botToken });
}
function reset() {
  sends.length = 0;
  tagCalls.length = 0;
  onSend = null;
}
function replyWith(text: string) {
  processing = true;
  processDeps = {
    makeModel: () => new FakeListChatModel({ responses: [text] }),
    checkpointer: new MemorySaver(),
    sleep: noSleep,
  };
}

describe.skipIf(!dbUp)("reply gate on a RyzeAPI number (Livare F2.1)", () => {
  let restoreDeliverer: ReturnType<typeof setBotDeliverer>;
  let restoreFactory: ReturnType<typeof setRyzeClientFactory>;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PORTAO", slug: `portao-${process.pid}` },
    });
    tenantId = t.id;
    restoreFactory = setRyzeClientFactory(async () => fakeRyze());
    restoreDeliverer = setBotDeliverer(async (d) => {
      const token = new URL(d.url).pathname.split("/").pop() as string;
      const r = await receiveChatwootWebhook({
        routeToken: token,
        rawBody: d.rawBody,
        getHeader: (name) => d.headers[name.toLowerCase()] ?? null,
        base: appDb,
      });
      if (
        processing &&
        r.outcome === "queued" &&
        r.tenantId !== undefined &&
        r.instanceId !== undefined &&
        r.deliveryId !== undefined &&
        r.normalized !== undefined
      ) {
        await recordAndProcessChatwootDelivery({
          tenantId: r.tenantId,
          instanceId: r.instanceId,
          deliveryId: r.deliveryId,
          agentBotId: r.agentBotId ?? null,
          normalized: r.normalized,
          base: appDb,
          deps: processDeps,
        });
      }
    });
    const view = await connectRyzeGateway(
      ctx(),
      {
        name: "Portao",
        baseUrl: outboundUrl("/"),
        instanceName: "portao",
        token: "tok",
      },
      { makeRyzeClient: async () => fakeRyze() },
      appDb,
    );
    instanceId = BigInt(view.instanceId);
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { debounce: { enabled: false } },
      },
      select: { id: true },
    });
    agentId = agent.id;
    const inbox = await runScopedOn(appDb, ctx(), (db) =>
      db.inbox.findFirstOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
    );
    await bindInbox(ctx(), inbox.id, agent.id, {}, appDb);
    const rows = await runScopedOn(appDb, ctx(), async (db) => ({
      gw: await db.ryzeGateway.findUniqueOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
      bot: await db.chatwootAgentBot.findFirstOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
    }));
    gatewayId = rows.gw.id;
    botToken = decryptJson<string>(rows.bot.accessToken);
    await catalog(REQUIRED, "TAG-IA");
    await catalog(HANDOFF, "TAG-VEND");
    await catalog("sem-sync", null);
  });

  afterAll(async () => {
    setBotDeliverer(restoreDeliverer);
    setRyzeClientFactory(restoreFactory);
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("off by default: an agent with no replyGate answers exactly as before", async () => {
    await setSettings({});
    const { jid } = await openConversation();
    reset();
    replyWith("Olá!");
    await inbound(jid, "oi");
    processing = false;
    expect(sends.map((s) => s.text)).toEqual(["Olá!"]);
  });

  test("on, no label: the agent says nothing, the message is still folded into memory, and a sanitized line names the seam and the reason", async () => {
    await setSettings(gateOn());
    const { jid, cid } = await openConversation();
    const ingestBefore = await suDb.schedulerJob.count({
      where: { tenantId, kind: "INGEST_MESSAGE" },
    });
    reset();
    replyWith("Não devia sair.");
    await inbound(jid, "quero saber o preço da expedição");
    processing = false;
    expect(sends).toEqual([]);
    const ingestAfter = await suDb.schedulerJob.count({
      where: { tenantId, kind: "INGEST_MESSAGE" },
    });
    expect(ingestAfter).toBeGreaterThan(ingestBefore);
    const lines = await gateLines(cid);
    const last = lines.at(-1);
    expect(last).toEqual({
      outcome: "reply_gate_closed",
      reason: "label_missing",
      seam: "receiver",
    });
    expect(JSON.stringify(lines)).not.toContain("expedição");
  });

  test("on, label present and synced: the agent answers", async () => {
    await setSettings(gateOn());
    const { jid, cid } = await openConversation();
    await setLabels(cid, [REQUIRED]);
    reset();
    replyWith("Claro!");
    await inbound(jid, "oi");
    processing = false;
    expect(sends.map((s) => s.text)).toEqual(["Claro!"]);
  });

  test("closed on doubt: a label the catalog does not know, one not synced to WhatsApp, and the hand-off label", async () => {
    for (const [labels, reason] of [
      [["outra-etiqueta"], "label_missing"],
      [[REQUIRED, HANDOFF], "handed_off"],
    ] as const) {
      await setSettings(gateOn());
      const { jid, cid } = await openConversation();
      await setLabels(cid, [...labels]);
      reset();
      replyWith("Não devia sair.");
      await inbound(jid, "oi");
      processing = false;
      expect(sends).toEqual([]);
      expect((await gateLines(cid)).at(-1)?.reason).toBe(reason);
    }
    await setSettings(gateOn({ requiredLabel: "sem-sync" }));
    const unsynced = await openConversation();
    await setLabels(unsynced.cid, ["sem-sync"]);
    reset();
    replyWith("Não devia sair.");
    await inbound(unsynced.jid, "oi");
    processing = false;
    expect(sends).toEqual([]);
    expect((await gateLines(unsynced.cid)).at(-1)?.reason).toBe(
      "label_unsynced",
    );
    await setSettings(gateOn({ requiredLabel: "nao-existe" }));
    const unknown = await openConversation();
    await setLabels(unknown.cid, ["nao-existe"]);
    reset();
    replyWith("Não devia sair.");
    await inbound(unknown.jid, "oi");
    processing = false;
    expect(sends).toEqual([]);
    expect((await gateLines(unknown.cid)).at(-1)?.reason).toBe("label_unknown");
  });

  test("in flight: the label coming off between balloon 1 and 2 stops balloon 2", async () => {
    await setSettings(gateOn());
    const { jid, cid } = await openConversation();
    await setLabels(cid, [REQUIRED]);
    reset();
    onSend = async () => {
      onSend = null;
      await setLabels(cid, []);
    };
    replyWith(TWO_BALLOONS);
    await inbound(jid, "me conta tudo");
    processing = false;
    expect(sends.map((s) => s.text)).toEqual(["Primeiro balão."]);
    expect((await gateLines(cid)).at(-1)).toMatchObject({ seam: "turn" });
  });

  test("hand-off: moving the conversation to the human queue swaps the labels on the phone, once", async () => {
    await setSettings(gateOn());
    const { cid } = await openConversation();
    await setLabels(cid, ["etapa-1", REQUIRED]);
    reset();
    const c = await client();
    await c.toggleStatus(cid, "open");
    await drainLabelSyncs(gatewayId);
    expect(await labelsOf(cid)).toEqual(["etapa-1", HANDOFF]);
    expect(tagCalls.map((t) => t.method).sort()).toEqual(["DELETE", "POST"]);
    expect(tagCalls.find((t) => t.method === "POST")?.body).toContain(
      "TAG-VEND",
    );
    expect(tagCalls.find((t) => t.method === "DELETE")?.body).toContain(
      "TAG-IA",
    );
    // Idempotent: back to the agent and over again changes nothing more than the first time.
    await c.toggleStatus(cid, "pending");
    await c.toggleStatus(cid, "open");
    await drainLabelSyncs(gatewayId);
    expect(await labelsOf(cid)).toEqual(["etapa-1", HANDOFF]);
  });

  test("hand-off with removeOnHandoff off, or a hand-off label missing from the catalog, never spends a catalog slot", async () => {
    await setSettings(
      gateOn({ removeOnHandoff: false, handoffLabel: "nao-catalogada" }),
    );
    const { cid } = await openConversation();
    await setLabels(cid, [REQUIRED]);
    const before = await suDb.ryzeLabel.count({ where: { gatewayId } });
    await (await client()).toggleStatus(cid, "open");
    await drainLabelSyncs(gatewayId);
    expect(await labelsOf(cid)).toEqual([REQUIRED]);
    expect(await suDb.ryzeLabel.count({ where: { gatewayId } })).toBe(before);
  });

  test("the transport refuses a bot send the gate closes, before a row or a provider call; a person's send and the human queue are not asked", async () => {
    await setSettings(gateOn());
    const { cid } = await openConversation(true);
    reset();
    const rowsBefore = await suDb.ryzeMessage.count({
      where: { gatewayId, conversationId: cid, messageType: 1 },
    });
    const err = await (await client())
      .sendMessage(cid, "fala do bot")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatwootApiError);
    expect((err as ChatwootApiError).status).toBe(422);
    expect(sends).toEqual([]);
    expect(
      await suDb.ryzeMessage.count({
        where: { gatewayId, conversationId: cid, messageType: 1 },
      }),
    ).toBe(rowsBefore);
    expect((await gateLines(cid)).at(-1)).toMatchObject({ seam: "transport" });
    // A person typing in the console (no bot token) is never held.
    const operator = new RyzeEmulator(tenantId, instanceId, { base: appDb });
    const res = await operator.fetch(
      `${operator.baseUrl}/api/v1/accounts/1/conversations/${cid}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "fala da pessoa",
          message_type: "outgoing",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(sends.map((s) => s.text)).toEqual(["fala da pessoa"]);
    // Nor is the human queue: the line a hand-off promised is the agent's to say there.
    await (await client()).toggleStatus(cid, "open");
    reset();
    await (await client()).sendMessage(cid, "um vendedor já te chama");
    expect(sends.map((s) => s.text)).toEqual(["um vendedor já te chama"]);
  });

  test("nudge: a follow-up in a conversation without the label spends no model call and sends nothing", async () => {
    await setSettings(gateOn());
    const { cid } = await openConversation(true);
    reset();
    let modelCalls = 0;
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:${cid}`,
      nudge: { source: "test" },
      base: appDb,
      deps: {
        makeModel: () => {
          modelCalls += 1;
          return new FakeListChatModel({ responses: ["Oi de novo!"] });
        },
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      },
    });
    expect(outcome).toBe("silent");
    expect(modelCalls).toBe(0);
    expect(sends).toEqual([]);
    expect((await gateLines(cid)).at(-1)).toMatchObject({ seam: "nudge" });
  });

  test("nudge with the label: the follow-up goes out (the gate only holds a conversation without it)", async () => {
    await setSettings(gateOn());
    const { cid } = await openConversation(true);
    await setLabels(cid, [REQUIRED]);
    reset();
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:${cid}`,
      nudge: { source: "test" },
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Oi de novo!"] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      },
    });
    expect(outcome).toBe("messaged");
    expect(sends.map((s) => s.text)).toEqual(["Oi de novo!"]);
  });

  test("test mode: /teste puts the required label on, so the activated conversation answers", async () => {
    await setSettings(gateOn());
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "test" },
    });
    try {
      const { jid, cid } = await openConversation();
      reset();
      processing = true;
      await inbound(jid, "/teste");
      expect(await labelsOf(cid)).toContain(REQUIRED);
      reset();
      replyWith("Testando!");
      await inbound(jid, "oi");
      processing = false;
      expect(sends.map((s) => s.text)).toEqual(["Testando!"]);
    } finally {
      processing = false;
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
  });
});
