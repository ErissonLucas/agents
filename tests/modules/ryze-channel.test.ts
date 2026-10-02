import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { bindInbox } from "@/modules/chatwoot/management";
import {
  hasDeviceAttendantShape,
  isNewIncomingMessage,
  parseLiveConversation,
} from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { receiveChatwootWebhook } from "@/modules/chatwoot/webhook";
import { RYZE_SOURCE, RyzeClient } from "@/modules/ryze/client";
import { drainEmits, setBotDeliverer } from "@/modules/ryze/emit";
import { setRyzeClientFactory } from "@/modules/ryze/emulator";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import { connectRyzeGateway } from "@/modules/ryze/service";
import { outboundUrl } from "../utils/outbound";

// The RyzeAPI channel end to end, minus the model: connecting a number, binding an agent, a customer
// message arriving through Ryze as a signed Agent Bot `message_created` that the Chatwoot receiver
// accepts, the agent's reply leaving through Ryze, our own echo being dropped, and a reply typed on the
// paired phone arriving in the device-reply shape.

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

interface RyzeCall {
  path: string;
  body: Record<string, unknown>;
}

// One counter for the whole suite: the emulator builds a client per send, and a counter per client
// would hand every send the same gateway id.
let n = 0;
function fakeRyze(calls: RyzeCall[]): RyzeClient {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ path: url.pathname, body });
    if (url.pathname.startsWith("/api/instance/list")) {
      return Response.json({
        success: true,
        instances: [
          {
            name: "amanda",
            status: "connected",
            connection: {
              state: "connected",
              numberJid: "5581996796431@s.whatsapp.net",
            },
            profile: { name: "Amanda" },
          },
        ],
      });
    }
    // Only sends take an id, so the suite's first message is WAOUT1 whatever was configured before.
    if (url.pathname.startsWith("/api/message/")) n += 1;
    return Response.json({
      success: true,
      data: { messageId: `WAOUT${n}`, timestamp: new Date().toISOString() },
    });
  }) as typeof fetch;
  return new RyzeClient(
    { baseUrl: outboundUrl("/"), instance: "amanda", token: "tok" },
    fetchImpl,
  );
}

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("RyzeAPI channel", () => {
  const calls: RyzeCall[] = [];
  const delivered: NormalizedChatwootEvent[] = [];
  const outcomes: string[] = [];
  let instanceId = 0n;
  let gatewayId = 0n;
  let auth = "";
  let routeToken = "";
  let botToken = "";
  let conversationId = 0;
  let restoreDeliverer: ReturnType<typeof setBotDeliverer>;
  let restoreFactory: ReturnType<typeof setRyzeClientFactory>;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RYZE", slug: `ryze-${process.pid}` },
    });
    tenantId = t.id;
    restoreFactory = setRyzeClientFactory(async () => fakeRyze(calls));
    restoreDeliverer = setBotDeliverer(async (d) => {
      const token = new URL(d.url).pathname.split("/").pop() as string;
      const res = await receiveChatwootWebhook({
        routeToken: token,
        rawBody: d.rawBody,
        getHeader: (name) => d.headers[name.toLowerCase()] ?? null,
        base: appDb,
      });
      outcomes.push(res.outcome);
      if (res.normalized) delivered.push(res.normalized);
    });
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

  test("connecting creates a RYZE account, its gateway and an inbox that reserves echoes", async () => {
    const view = await connectRyzeGateway(
      ctx(),
      {
        name: "Amanda Sena",
        baseUrl: outboundUrl("/"),
        instanceName: "amanda",
        token: "tok",
      },
      { makeRyzeClient: async () => fakeRyze(calls) },
      appDb,
    );
    instanceId = BigInt(view.instanceId);
    expect(view.connectionState).toBe("connected");
    const webhook = calls.find((c) => c.path.startsWith("/api/events/webhook"));
    expect(webhook?.body.enabled).toBe(true);
    expect(String(webhook?.body.url)).toContain("/api/v1/ryze/webhook/");
    routeToken = String(webhook?.body.url).split("/").pop() as string;
    auth = String(webhook?.body.authorization);

    const rows = await runScopedOn(appDb, ctx(), async (db) => ({
      instance: await db.chatwootInstance.findUniqueOrThrow({
        where: { id: instanceId },
      }),
      gateway: await db.ryzeGateway.findUniqueOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
      inbox: await db.inbox.findFirstOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
    }));
    gatewayId = rows.gateway.id;
    expect(rows.instance.kind).toBe("RYZE");
    expect(rows.inbox.provider).toBe("ryze");
    expect(rows.inbox.chatwootInboxId).toBe(rows.gateway.inboxId);
  });

  test("binding an agent provisions an emulated bot attached to the inbox", async () => {
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Lara", systemPrompt: "x" },
      select: { id: true },
    });
    const inbox = await runScopedOn(appDb, ctx(), (db) =>
      db.inbox.findFirstOrThrow({ where: { chatwootInstanceId: instanceId } }),
    );
    await bindInbox(ctx(), inbox.id, agent.id, {}, appDb);
    const rows = await runScopedOn(appDb, ctx(), async (db) => ({
      bot: await db.chatwootAgentBot.findFirstOrThrow({
        where: { chatwootInstanceId: instanceId },
      }),
      gateway: await db.ryzeGateway.findUniqueOrThrow({
        where: { id: gatewayId },
      }),
    }));
    expect(rows.gateway.agentBotId).toBe(rows.bot.chatwootAgentBotId);
    botToken = decryptJson<string>(rows.bot.accessToken);
  });

  test("a customer message reaches the Chatwoot receiver as a signed incoming message_created", async () => {
    const res = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          id: "WAIN1",
          message: {
            id: "WAIN1",
            direction: "incoming",
            timestamp: new Date().toISOString(),
            chat: { jid: "5581999990000", name: "Cliente", type: "private" },
            sender: { jid: "5581999990000", name: "Cliente" },
            content: { text: "oi, quanto é a consulta?" },
          },
        },
      }),
    });
    expect(res.outcome).toBe("accepted");
    await drainEmits(gatewayId);
    expect(outcomes.at(-1)).toBe("queued");
    const event = delivered.at(-1) as NormalizedChatwootEvent;
    expect(isNewIncomingMessage(event)).toBe(true);
    expect(event.message?.content).toBe("oi, quanto é a consulta?");
    expect(event.status).toBe("pending");
    conversationId = event.conversationId as number;
  });

  test("a wrong Authorization is refused and a redelivery is a duplicate", async () => {
    const bad = await receiveRyzeWebhook({
      routeToken,
      authorization: "Bearer nope",
      base: appDb,
      rawBody: "{}",
    });
    expect(bad.status).toBe(401);
    const again = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          message: {
            id: "WAIN1",
            direction: "incoming",
            chat: { jid: "5581999990000", type: "private" },
            content: { text: "oi, quanto é a consulta?" },
          },
        },
      }),
    });
    expect(again.outcome).toBe("duplicate");
  });

  test("the agent's reply leaves through Ryze and is readable back as an outgoing message", async () => {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken,
    });
    const sent = (await client.sendMessage(conversationId, "Te passo sim!", {
      sendId: "s-1",
    })) as { id: number };
    expect(typeof sent.id).toBe("number");
    const send = calls.findLast((c) => c.path.startsWith("/api/message/text"));
    expect(send?.body.number).toBe("5581999990000");
    expect(send?.body.source).toBe(RYZE_SOURCE);
    const page = (await client.getMessages(conversationId)) as {
      payload: Array<{
        id: number;
        message_type: number;
        content_attributes: Record<string, unknown>;
      }>;
    };
    const mine = page.payload.find((m) => m.id === sent.id);
    expect(mine?.message_type).toBe(1);
    expect(mine?.content_attributes.fazer_ai_send_id).toBe("s-1");
    await drainEmits(gatewayId);
    const echo = delivered.at(-1) as NormalizedChatwootEvent;
    expect(echo.message?.messageType).toBe("outgoing");
    expect(echo.message?.sender?.type).toBe("agent_bot");
  });

  test("our own send coming back through the webhook is dropped", async () => {
    const before = delivered.length;
    const tagged = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          message: {
            id: "WAOUT-tagged",
            direction: "outgoing",
            source: RYZE_SOURCE,
            chat: { jid: "5581999990000", type: "private" },
            content: { text: "Te passo sim!" },
          },
        },
      }),
    });
    expect(tagged.outcome).toBe("ignored");
    const lastSend = calls.findLast((c) =>
      c.path.startsWith("/api/message/text"),
    );
    expect(lastSend).toBeDefined();
    const untaggedSameId = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          message: {
            id: "WAOUT1",
            direction: "outgoing",
            chat: { jid: "5581999990000", type: "private" },
            content: { text: "Te passo sim!" },
          },
        },
      }),
    });
    expect(untaggedSameId.outcome).toBe("duplicate");
    await drainEmits(gatewayId);
    expect(delivered.length).toBe(before);
  });

  test("a reply typed on the paired phone arrives in the device-reply shape", async () => {
    const res = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          message: {
            id: "WAPHONE1",
            direction: "outgoing",
            chat: { jid: "5581999990000", type: "private" },
            content: { text: "Oi, aqui é a Amanda, vou te atender" },
          },
        },
      }),
    });
    expect(res.outcome).toBe("accepted");
    await drainEmits(gatewayId);
    const event = delivered.at(-1) as NormalizedChatwootEvent;
    expect(event.message?.messageType).toBe("outgoing");
    expect(hasDeviceAttendantShape(event)).toBe(true);
  });

  test("a send by another system on the number (automation source) is history, not a person on the phone", async () => {
    config.ryzeAutomationSources.push("villa-app");
    try {
      const res = await receiveRyzeWebhook({
        routeToken,
        authorization: auth,
        base: appDb,
        rawBody: JSON.stringify({
          event: "message.exchange",
          data: {
            message: {
              id: "WAAPP1",
              direction: "outgoing",
              source: "villa-app",
              chat: { jid: "5581999990000", type: "private" },
              content: { text: "Tá na chapa! Assim que sair, te aviso aqui." },
            },
          },
        }),
      });
      expect(res.outcome).toBe("accepted");
      await drainEmits(gatewayId);
      const event = delivered.at(-1) as NormalizedChatwootEvent;
      expect(event.message?.messageType).toBe("outgoing");
      expect(event.message?.content).toBe(
        "Tá na chapa! Assim que sair, te aviso aqui.",
      );
      expect(hasDeviceAttendantShape(event)).toBe(false);
    } finally {
      config.ryzeAutomationSources.length = 0;
    }
  });

  test("a reply carrying buttons (send_buttons) leaves as a WhatsApp card", async () => {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken,
    });
    expect(client.isRyzeEmulator).toBe(true);
    await client.sendMessage(conversationId, "Bora fechar?", {
      sendId: "s-btn",
      buttons: [
        { id: "btn-1", title: "Quero" },
        { id: "btn-2", title: "Ver cardápio" },
      ],
    });
    const card = calls.findLast((c) => c.path.startsWith("/api/message/"));
    expect(card?.path.startsWith("/api/message/button")).toBe(true);
    expect(card?.body.contentText).toBe("Bora fechar?");
    expect(card?.body.buttons).toEqual([
      { id: "btn-1", displayText: "Quero", type: "REPLY" },
      { id: "btn-2", displayText: "Ver cardápio", type: "REPLY" },
    ]);

    await client.sendMessage(conversationId, "Seu link", {
      buttons: [
        {
          url: "https://villaengenho.com.br/sacola?s=x",
          title: "Finalizar pedido",
        },
      ],
    });
    const link = calls.findLast((c) => c.path.startsWith("/api/message/"));
    expect(link?.body.buttons).toEqual([
      {
        id: "https://villaengenho.com.br/sacola?s=x",
        displayText: "Finalizar pedido",
        type: "URL",
      },
    ]);
  });

  test("buttons that break the card rules do not stop the reply: it leaves as plain text", async () => {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken,
    });
    await client.sendMessage(conversationId, "Escolhe aí", {
      buttons: [
        { id: "btn-1", title: "Um" },
        { url: "https://exemplo.com", title: "Dois" },
      ],
    });
    const send = calls.findLast((c) => c.path.startsWith("/api/message/"));
    expect(send?.path.startsWith("/api/message/text")).toBe(true);
  });

  test("a reply carrying a carousel (send_carousel) leaves as cards, and a tap names the card", async () => {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken,
    });
    const card = (n: number, title: string) => ({
      id: `card-${n}`,
      title,
      text: "Picanha selada e queijo derretendo.",
      footer: "R$ 47,99",
      imageUrl: `https://villaengenho.com.br/menu/${n}.jpg`,
      buttonTitle: "Quero esse",
    });
    await client.sendMessage(conversationId, "Olha as ofertas 🔥", {
      carousel: [card(1, "Super Oferta"), card(2, "Trio Ternura")],
    });
    const sent = calls.findLast((c) => c.path.startsWith("/api/message/"));
    expect(sent?.path.startsWith("/api/message/carousel")).toBe(true);
    expect(sent?.body.message).toBe("Olha as ofertas 🔥");
    expect((sent?.body.cards as unknown[])[1]).toEqual({
      header: {
        title: "Trio Ternura",
        imageUrl: "https://villaengenho.com.br/menu/2.jpg",
      },
      body: { text: "Picanha selada e queijo derretendo." },
      footer: "R$ 47,99",
      buttons: [{ id: "card-2", displayText: "Quero esse", type: "REPLY" }],
    });

    const tap = await receiveRyzeWebhook({
      routeToken,
      authorization: auth,
      base: appDb,
      rawBody: JSON.stringify({
        event: "message.exchange",
        data: {
          message: {
            id: "WATAP-CARD",
            direction: "incoming",
            type: "template_button_reply",
            chat: { jid: "5581999990000", type: "private" },
            content: { text: "card-2" },
            interactive: { selectedButtonId: "card-2", title: "Quero esse" },
          },
        },
      }),
    });
    expect(tap.outcome).toBe("accepted");
    await drainEmits(gatewayId);
    const event = delivered.at(-1) as NormalizedChatwootEvent;
    expect(event.message?.content).toBe("Quero esse — Trio Ternura");

    await client.sendMessage(conversationId, "Só um", {
      carousel: [card(1, "Super Oferta")],
    });
    const lone = calls.findLast((c) => c.path.startsWith("/api/message/"));
    expect(lone?.path.startsWith("/api/message/text")).toBe(true);
  });

  test("status changes are served live and announced to the bot", async () => {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      botToken,
    });
    await client.toggleStatus(conversationId, "open");
    const live = parseLiveConversation(
      await client.getConversation(conversationId),
    );
    expect(live?.status).toBe("open");
    await drainEmits(gatewayId);
    expect(
      delivered.some((e) => e.event === "conversation_status_changed"),
    ).toBe(true);
  });
});
