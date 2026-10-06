import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { type RuntimeDeps, runAgentTurn } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ChatwootApiError, ChatwootClient } from "@/modules/chatwoot/client";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { bindInbox } from "@/modules/chatwoot/management";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { listConversations } from "@/modules/conversations/service";
import { flushDebounceJob } from "@/modules/debounce/handler";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import { RyzeClient } from "@/modules/ryze/client";
import { drainEmits, setBotDeliverer } from "@/modules/ryze/emit";
import { RyzeEmulator, setRyzeClientFactory } from "@/modules/ryze/emulator";
import { receiveRyzeWebhook } from "@/modules/ryze/receiver";
import { connectRyzeGateway } from "@/modules/ryze/service";
import {
  latestMessageId,
  RYZE_STATUS_NOT_DISPATCHED,
  RYZE_STATUS_SENDING,
  RYZE_STATUS_UNCERTAIN,
} from "@/modules/ryze/store";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import {
  accountForRejectedSend,
  deliverReply,
  SPLIT_DEFAULTS,
} from "@/modules/split/service";
import { outboundUrl } from "../utils/outbound";
import { burnSchedulerJobId } from "../utils/scheduler";
import { ResolveThenReplyModel } from "../utils/scripted-models";

// F2.1-A (docs/LIVARE-F21-A-ENVIO-INCERTO.md): a RyzeAPI send whose outcome is uncertain is never sent
// again. Everything here runs the REAL emulator, store, ChatwootClient, split loop and runtime against
// the test database; only RyzeAPI's own HTTP is faked, and the fake records which sends the provider
// TOOK (accepted), which is the fact the customer's phone depends on and our side cannot see.

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

// What the fake RyzeAPI does with the next SEND (text, media, buttons, carousel). Presence, read
// receipts and the rest never consume the script.
type Behaviour =
  | "ok" // takes it, answers 200 with an id
  | "accept-then-timeout" // takes it, the answer is lost to a timeout
  | "accept-then-reset" // takes it, the connection drops before the answer
  | "accept-then-500" // takes it, answers 500 anyway
  | "accept-then-400" // takes it, answers 400 anyway
  | "reject-500" // does NOT take it, answers 500
  | "hang"; // takes it only when `release()` is called
interface ProviderSend {
  path: string;
  text: string;
  behaviour: Behaviour;
  accepted: boolean;
}
const provider: ProviderSend[] = [];
// Every RyzeAPI path called, sends or not (labels, presence...), for the follow-up's "nothing at all".
const providerPaths: string[] = [];
let script: Behaviour[] = [];
let failMakeRyze = 0;
let gate: { promise: Promise<void>; release: () => void } | null = null;
let onSend: (() => Promise<void>) | null = null;
const hook = { url: "", auth: "" };
let n = 0;

const SEND_PATHS = [
  "/api/message/text",
  "/api/message/media",
  "/api/message/button",
  "/api/message/carousel",
];

function fakeRyze(): RyzeClient {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    providerPaths.push(url.pathname);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (url.pathname.startsWith("/api/events/webhook")) {
      hook.url = String(body.url);
      hook.auth = String(body.authorization);
    }
    if (url.pathname.startsWith("/api/instance/list")) {
      return Response.json({
        success: true,
        instances: [
          {
            name: "incerto",
            status: "connected",
            connection: {
              state: "connected",
              numberJid: "5581900000009@s.whatsapp.net",
            },
            profile: { name: "Incerto" },
          },
        ],
      });
    }
    if (SEND_PATHS.some((p) => url.pathname.startsWith(p))) {
      const behaviour = script.shift() ?? "ok";
      const text = String(
        body.message ?? body.contentText ?? body.caption ?? "",
      );
      const accepted = behaviour !== "reject-500";
      const path = SEND_PATHS.find((p) => url.pathname.startsWith(p)) as string;
      provider.push({ path, text, behaviour, accepted });
      n += 1;
      if (onSend) await onSend();
      if (behaviour === "hang" && gate) await gate.promise;
      if (behaviour === "accept-then-timeout")
        throw new DOMException("The operation timed out.", "TimeoutError");
      if (behaviour === "accept-then-reset")
        throw new TypeError("fetch failed: socket closed");
      if (behaviour === "accept-then-500" || behaviour === "reject-500")
        return Response.json(
          { success: false, error: { message: "boom" } },
          { status: 500 },
        );
      if (behaviour === "accept-then-400")
        return Response.json(
          { success: false, error: { message: "bad" } },
          { status: 400 },
        );
      return Response.json({
        success: true,
        data: { messageId: `PROV${n}`, timestamp: new Date().toISOString() },
      });
    }
    return Response.json({ success: true, data: {} });
  }) as typeof fetch;
  return new RyzeClient(
    { baseUrl: outboundUrl("/"), instance: "incerto", token: "tok" },
    fetchImpl,
  );
}

let tenantId = 0n;
let instanceId = 0n;
let gatewayId = 0n;
let agentId = 0n;
let agentBotId = 0;
let botToken = "";
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const noSleep = async () => {};
const SPLIT_ON = { ...SPLIT_DEFAULTS, enabled: true };
const SPLIT_OFF = { ...SPLIT_DEFAULTS, enabled: false };
const TWO_BALLOONS = "Primeiro balão.\n\nSegundo balão.";

// The bot deliverer: "capture" only acks (the normalized event is kept), "process" runs the real
// detached half with the deps the scenario hands it.
let deliverMode: "capture" | "process" = "capture";
let processDeps: RuntimeDeps = {};
const captured: NormalizedChatwootEvent[] = [];

async function setAgentSettings(settings: Record<string, unknown>) {
  await suDb.agent.update({
    where: { id: agentId },
    data: { settings: settings as Prisma.InputJsonValue },
  });
}

let jidSeq = 0;
let msgSeq = 0;
// A new customer conversation, opened by a real inbound through the receiver.
async function inbound(text = "oi, tudo bem?"): Promise<{
  conversationId: number;
  event: NormalizedChatwootEvent;
}> {
  jidSeq += 1;
  msgSeq += 1;
  const jid = `5581977${String(jidSeq).padStart(6, "0")}`;
  const before = captured.length;
  const res = await receiveRyzeWebhook({
    routeToken: hook.url.split("/").pop() as string,
    authorization: hook.auth,
    base: appDb,
    rawBody: JSON.stringify({
      event: "message.exchange",
      data: {
        message: {
          id: `IN-${process.pid}-${msgSeq}`,
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
  const event = captured
    .slice(before)
    .find(
      (e) =>
        e.event === "message_created" &&
        e.message?.messageType === "incoming" &&
        e.message?.content === text,
    ) as NormalizedChatwootEvent;
  return { conversationId: event.conversationId as number, event };
}

async function rowsOf(conversationId: number) {
  return runScopedOn(appDb, ctx(), (db) =>
    db.ryzeMessage.findMany({
      where: { gatewayId, conversationId, messageType: 1 },
      orderBy: { messageId: "asc" },
      select: {
        messageId: true,
        content: true,
        status: true,
        externalId: true,
        contentAttributes: true,
      },
    }),
  );
}
const stateOf = (r: { contentAttributes: unknown }) =>
  (r.contentAttributes as Record<string, unknown>).fazer_ai_ryze_delivery;

async function client() {
  return loadChatwootClient(tenantId, instanceId, { base: appDb, botToken });
}

async function conversationRow(conversationId: number) {
  return runScopedOn(appDb, ctx(), (db) =>
    db.conversation.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
      },
      select: { id: true, lastError: true, status: true },
    }),
  );
}

function reset(behaviours: Behaviour[]) {
  provider.length = 0;
  script = [...behaviours];
}
const accepted = () => provider.filter((p) => p.accepted).map((p) => p.text);

describe.skipIf(!dbUp)(
  "F2.1-A: an uncertain RyzeAPI send is never sent twice",
  () => {
    let restoreDeliverer: ReturnType<typeof setBotDeliverer>;
    let restoreFactory: ReturnType<typeof setRyzeClientFactory>;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "INCERTO", slug: `incerto-${process.pid}` },
      });
      tenantId = t.id;
      restoreFactory = setRyzeClientFactory(async () => {
        if (failMakeRyze > 0) {
          failMakeRyze -= 1;
          throw new Error("gateway token could not be decrypted");
        }
        return fakeRyze();
      });
      restoreDeliverer = setBotDeliverer(async (d) => {
        const token = new URL(d.url).pathname.split("/").pop() as string;
        const r = await receiveChatwootWebhook({
          routeToken: token,
          rawBody: d.rawBody,
          getHeader: (name) => d.headers[name.toLowerCase()] ?? null,
          base: appDb,
        });
        if (r.normalized) captured.push(r.normalized);
        if (
          deliverMode === "process" &&
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
          name: "Incerto",
          baseUrl: outboundUrl("/"),
          instanceName: "incerto",
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
      const ttsKey = await suDb.vaultEntry.create({
        data: { tenantId, name: "tts", secret: encryptJson("sk-tts") },
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
      ttsKeyRef = `vault:${ttsKey.id}`;
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
      agentBotId = rows.gw.agentBotId as number;
      botToken = decryptJson<string>(rows.bot.accessToken);
    });

    afterAll(async () => {
      setBotDeliverer(restoreDeliverer);
      setRyzeClientFactory(restoreFactory);
      for (const id of [tenantId, otherTenantId]) {
        if (id)
          await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // ── A1/A8: text, split on — every post-dispatch failure is uncertain, none is resent ──
    for (const b of [
      "accept-then-timeout",
      "accept-then-reset",
      "accept-then-500",
      "accept-then-400",
    ] as Behaviour[]) {
      test(`A1 split on, balloon 2 ${b}: one provider call per balloon, no resend, unproven`, async () => {
        deliverMode = "capture";
        const { conversationId } = await inbound();
        reset(["ok", b]);
        const out = await deliverReply(
          await client(),
          conversationId,
          TWO_BALLOONS,
          SPLIT_ON,
          noSleep,
        );
        expect(provider.map((p) => p.text)).toEqual([
          "Primeiro balão.",
          "Segundo balão.",
        ]);
        expect(out).toEqual({ delivered: 1, failed: true, unproven: true });
        const rows = await rowsOf(conversationId);
        expect(rows.map((r) => [r.content, r.status, stateOf(r)])).toEqual([
          ["Primeiro balão.", "sent", "provider_accepted"],
          ["Segundo balão.", RYZE_STATUS_UNCERTAIN, "uncertain"],
        ]);
        // the attempt keeps its name: the evidence a read-back is asked about
        const kept = rows[1];
        if (!kept) throw new Error("the uncertain attempt was not kept");
        expect(
          typeof (kept.contentAttributes as Record<string, unknown>)
            .fazer_ai_send_id,
        ).toBe("string");
      });
    }

    test("A1 control: a provider that answered 500 WITHOUT taking it is still not resent (status proves nothing)", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["ok", "reject-500"]);
      const out = await deliverReply(
        await client(),
        conversationId,
        TWO_BALLOONS,
        SPLIT_ON,
        noSleep,
      );
      expect(provider).toHaveLength(2);
      expect(accepted()).toEqual(["Primeiro balão."]);
      expect(out).toEqual({ delivered: 1, failed: true, unproven: true });
    });

    test("A2 split off: uncertain single send => {0, failed, unproven}, nothing resent", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["accept-then-timeout"]);
      const out = await deliverReply(
        await client(),
        conversationId,
        TWO_BALLOONS,
        SPLIT_OFF,
        noSleep,
      );
      expect(provider).toHaveLength(1);
      expect(out).toEqual({ delivered: 0, failed: true, unproven: true });
    });

    // ── A3: buttons and carousel ride the last balloon; an uncertain card is not sent again ──
    test("A3 buttons: uncertain card is neither resent as a card nor as text", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["accept-then-timeout"]);
      const out = await deliverReply(
        await client(),
        conversationId,
        "Bora fechar?",
        SPLIT_OFF,
        noSleep,
        undefined,
        undefined,
        null,
        null,
        [
          { id: "b1", title: "Quero" },
          { id: "b2", title: "Depois" },
        ],
      );
      expect(provider.map((p) => p.path)).toEqual(["/api/message/button"]);
      expect(out).toEqual({ delivered: 0, failed: true, unproven: true });
      expect((await rowsOf(conversationId)).map((r) => r.status)).toEqual([
        RYZE_STATUS_UNCERTAIN,
      ]);
    });

    test("A3 carousel: uncertain cards are not sent again", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["accept-then-reset"]);
      const card = (k: number) => ({
        id: `c${k}`,
        title: `Opção ${k}`,
        text: "Descrição",
        imageUrl: `https://203.0.113.10/${k}.jpg`,
        buttonTitle: "Quero",
      });
      const out = await deliverReply(
        await client(),
        conversationId,
        "Olha as opções",
        SPLIT_OFF,
        noSleep,
        undefined,
        undefined,
        null,
        null,
        null,
        [card(1), card(2)],
      );
      expect(provider.map((p) => p.path)).toEqual(["/api/message/carousel"]);
      expect(out).toEqual({ delivered: 0, failed: true, unproven: true });
    });

    // ── A6: the only resend is on a durable `not_dispatched` record ──
    test("A6 pre-dispatch failure: row KEPT as not_dispatched, and only that proof allows the resend", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["ok", "ok"]);
      // Balloon 1 goes out; then the client cannot be built twice — balloon 2's typing indicator
      // (best-effort, swallowed) and balloon 2's send, which therefore never reaches the provider.
      // The consolidated retry builds it again and goes out.
      let armed = true;
      onSend = async () => {
        if (armed) {
          armed = false;
          failMakeRyze = 2;
        }
      };
      try {
        const out = await deliverReply(
          await client(),
          conversationId,
          TWO_BALLOONS,
          SPLIT_ON,
          noSleep,
        );
        expect(out).toEqual({ delivered: 2, failed: false, unproven: false });
      } finally {
        onSend = null;
        failMakeRyze = 0;
      }
      expect(accepted()).toEqual(["Primeiro balão.", "Segundo balão."]);
      const rows = await rowsOf(conversationId);
      expect(rows.map((r) => [r.content, r.status, stateOf(r)])).toEqual([
        ["Primeiro balão.", "sent", "provider_accepted"],
        ["Segundo balão.", RYZE_STATUS_NOT_DISPATCHED, "not_dispatched"],
        ["Segundo balão.", "sent", "provider_accepted"],
      ]);
    });

    test("A6 negative controls: 422 with no record, two records, contradictory record => unknown", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      const c = await client();
      const err = new ChatwootApiError(422, "POST /messages");
      // 422 and nothing recorded under that name
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "never-sent-anything",
          null,
          err,
          undefined,
        ),
      ).toEqual({ known: false });
      // two rows carrying one name (an operator automation, a replay): never pick one
      const seed = (
        sendId: string,
        status: string,
        externalId: string | null,
      ) =>
        runScopedOn(appDb, ctx(), (db) =>
          db.ryzeMessage.create({
            data: {
              tenantId,
              gatewayId,
              conversationId,
              messageType: 1,
              content: "x",
              contentAttributes: {
                fazer_ai_send_id: sendId,
                fazer_ai_ryze_delivery: "not_dispatched",
              },
              status,
              externalId,
              senderType: "agent_bot",
              senderId: agentBotId,
            },
          }),
        );
      await seed("dup", RYZE_STATUS_NOT_DISPATCHED, null);
      await seed("dup", RYZE_STATUS_NOT_DISPATCHED, null);
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "dup",
          null,
          err,
          undefined,
        ),
      ).toEqual({ known: false });
      // a not_dispatched record that carries a provider id contradicts itself
      await seed("contra", RYZE_STATUS_NOT_DISPATCHED, "PROVX");
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "contra",
          null,
          err,
          undefined,
        ),
      ).toEqual({ known: false });
      // the clean proof, for contrast
      await seed("clean", RYZE_STATUS_NOT_DISPATCHED, null);
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "clean",
          null,
          err,
          undefined,
        ),
      ).toEqual({ known: true, id: null });
    });

    // ── A7/A8: the provider's acceptance survives local failures ──
    test("A7 provider accepted, the conversation write fails twice: 200, provider_accepted_unrecorded, no resend", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      const conv = await runScopedOn(appDb, ctx(), (db) =>
        db.ryzeConversation.findFirstOrThrow({
          where: { gatewayId, displayId: conversationId },
          select: { id: true },
        }),
      );
      // touchConversation (inside the acceptance write) refused, the bare row write allowed
      await suDb.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION pg_temp_f21a_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'f21a: refused'; END $$`,
      );
      await suDb.$executeRawUnsafe(
        `CREATE TRIGGER f21a_refuse_touch BEFORE UPDATE ON ryze_conversations FOR EACH ROW WHEN (OLD.id = ${conv.id}) EXECUTE FUNCTION pg_temp_f21a_refuse()`,
      );
      try {
        reset(["ok"]);
        const out = await deliverReply(
          await client(),
          conversationId,
          "Uma só.",
          SPLIT_OFF,
          noSleep,
        );
        expect(out).toEqual({ delivered: 1, failed: false, unproven: false });
      } finally {
        await suDb.$executeRawUnsafe(
          "DROP TRIGGER IF EXISTS f21a_refuse_touch ON ryze_conversations",
        );
        await suDb.$executeRawUnsafe(
          "DROP FUNCTION IF EXISTS pg_temp_f21a_refuse()",
        );
      }
      expect(provider).toHaveLength(1);
      const rows = await rowsOf(conversationId);
      expect(rows.map((r) => [r.status, stateOf(r), r.externalId])).toEqual([
        [
          "sent",
          "provider_accepted_unrecorded",
          expect.stringMatching(/^PROV/),
        ],
      ]);
    });

    test("A7 provider accepted, every local write fails: still 200 and no resend; the row reads unknown, never absent", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      await suDb.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION pg_temp_f21a_refuse_msg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'f21a: refused'; END $$`,
      );
      // armed by the send itself: the row exists (inserted before the call), every later write refused
      onSend = async () => {
        await suDb.$executeRawUnsafe(
          `CREATE TRIGGER f21a_refuse_msg BEFORE UPDATE ON ryze_messages FOR EACH ROW WHEN (OLD.conversation_id = ${conversationId} AND OLD.gateway_id = ${gatewayId}) EXECUTE FUNCTION pg_temp_f21a_refuse_msg()`,
        );
      };
      let out: Awaited<ReturnType<typeof deliverReply>>;
      try {
        reset(["ok"]);
        out = await deliverReply(
          await client(),
          conversationId,
          "Uma só.",
          SPLIT_OFF,
          noSleep,
        );
      } finally {
        onSend = null;
        await suDb.$executeRawUnsafe(
          "DROP TRIGGER IF EXISTS f21a_refuse_msg ON ryze_messages",
        );
        await suDb.$executeRawUnsafe(
          "DROP FUNCTION IF EXISTS pg_temp_f21a_refuse_msg()",
        );
      }
      expect(out).toEqual({ delivered: 1, failed: false, unproven: false });
      expect(provider).toHaveLength(1);
      const rows = await rowsOf(conversationId);
      expect(rows.map((r) => r.status)).toEqual([RYZE_STATUS_SENDING]);
    });

    test("A8 echo delivery fails after acceptance: the send stays accepted (200, sent), nothing resent", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      const prev = setBotDeliverer(async () => {
        throw new Error("bot endpoint down");
      });
      try {
        reset(["ok"]);
        const out = await deliverReply(
          await client(),
          conversationId,
          "Uma só.",
          SPLIT_OFF,
          noSleep,
        );
        await drainEmits(gatewayId);
        expect(out).toEqual({ delivered: 1, failed: false, unproven: false });
      } finally {
        setBotDeliverer(prev);
      }
      expect(provider).toHaveLength(1);
      expect((await rowsOf(conversationId)).map((r) => r.status)).toEqual([
        "sent",
      ]);
    });

    // ── A9: a read-back that meets a send still in flight answers unknown ──
    test("A9 a send still `sending` reads unknown, and stays unresent when the provider then takes it", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      let release = () => {};
      gate = {
        promise: new Promise<void>((r) => {
          release = r;
        }),
        release: () => release(),
      };
      reset(["hang"]);
      const c = await client();
      const inFlight = c.sendMessage(conversationId, "Em voo.", {
        sendId: "voo-1",
      });
      for (let i = 0; i < 100 && provider.length === 0; i++)
        await Bun.sleep(10);
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "voo-1",
          null,
          new Error("timeout"),
          undefined,
        ),
      ).toEqual({ known: false });
      // hidden from history while in flight
      expect(
        parseChatwootMessages(await c.getMessages(conversationId)).some(
          (m) => m.sendId === "voo-1",
        ),
      ).toBe(false);
      gate.release();
      await inFlight;
      gate = null;
      expect(provider).toHaveLength(1);
      expect(
        await accountForRejectedSend(
          c,
          conversationId,
          "voo-1",
          null,
          new Error("timeout"),
          undefined,
        ),
      ).toEqual({ known: true, id: expect.any(Number) });
    });

    // ── A12: history readers never see an attempt; everything else is untouched ──
    test("A12 history hides only the emulator's unsettled attempts: inbound, legacy `sending`, `delivered` and accepted rows stay", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound("mensagem do cliente");
      reset(["ok", "accept-then-timeout"]);
      await deliverReply(
        await client(),
        conversationId,
        TWO_BALLOONS,
        SPLIT_ON,
        noSleep,
      );
      const legacy = (status: string, content: string) =>
        runScopedOn(appDb, ctx(), (db) =>
          db.ryzeMessage.create({
            data: {
              tenantId,
              gatewayId,
              conversationId,
              messageType: 1,
              content,
              contentAttributes: {},
              status,
              senderType: "user",
              senderId: 1,
            },
          }),
        );
      await legacy("sending", "linha legada em envio");
      await legacy("delivered", "status nativo de provedor");
      const page = parseChatwootMessages(
        await (await client()).getMessages(conversationId),
      );
      expect(page.map((m) => m.content)).toEqual([
        "mensagem do cliente",
        "Primeiro balão.",
        "linha legada em envio",
        "status nativo de provedor",
      ]);
      const uncertain = (await rowsOf(conversationId)).find(
        (r) => r.status === RYZE_STATUS_UNCERTAIN,
      );
      const latest = await runScopedOn(appDb, ctx(), (db) =>
        latestMessageId(db, gatewayId, conversationId),
      );
      expect(latest).not.toBe(uncertain?.messageId);
      expect(latest).toBe(page.at(-1)?.id as number);
    });

    // ── A13: the delivery state is the emulator's own ──
    test("A13 a caller-forged delivery state is dropped: a forged not_dispatched on a timed-out send reads uncertain", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["accept-then-timeout"]);
      const emulator = new RyzeEmulator(tenantId, instanceId, { base: appDb });
      const res = await emulator.fetch(
        `${emulator.baseUrl}/api/v1/accounts/1/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { [CHATWOOT_AUTH_HEADER]: botToken },
          body: JSON.stringify({
            content: "forjado",
            message_type: "outgoing",
            content_attributes: {
              fazer_ai_send_id: "forjado-1",
              fazer_ai_ryze_delivery: "not_dispatched",
            },
          }),
        },
      );
      expect(res.status).toBe(502);
      const rows = await rowsOf(conversationId);
      expect(rows.map((r) => [r.status, stateOf(r)])).toEqual([
        [RYZE_STATUS_UNCERTAIN, "uncertain"],
      ]);
      expect(
        await accountForRejectedSend(
          await client(),
          conversationId,
          "forjado-1",
          null,
          new ChatwootApiError(502, "POST"),
          undefined,
        ),
      ).toEqual({ known: false });
    });

    // ── A17: the lookup by name answers only a bot of this gateway, about this conversation ──
    test("A17 send-state lookup: admin constant, no token and another gateway's bot are refused; another conversation and another tenant see nothing", async () => {
      deliverMode = "capture";
      const { conversationId } = await inbound();
      reset(["accept-then-timeout"]);
      await (await client())
        .sendMessage(conversationId, "segredo", { sendId: "isolado-1" })
        .catch(() => undefined);
      const emulator = new RyzeEmulator(tenantId, instanceId, { base: appDb });
      const ask = (cid: number, token: string | null, e = emulator) =>
        e.fetch(
          `${e.baseUrl}/api/v1/accounts/1/conversations/${cid}/messages?send_id=isolado-1`,
          { headers: token ? { [CHATWOOT_AUTH_HEADER]: token } : {} },
        );
      expect((await ask(conversationId, "ryze-emulator-admin")).status).toBe(
        401,
      );
      expect((await ask(conversationId, null)).status).toBe(401);
      const ok = await ask(conversationId, botToken);
      expect(ok.status).toBe(200);
      expect(
        ((await ok.json()) as { records: unknown[] }).records,
      ).toHaveLength(1);
      // the same name asked about another conversation of the same gateway
      const other = await inbound();
      const elsewhere = await ask(other.conversationId, botToken);
      expect(
        ((await elsewhere.json()) as { records: unknown[] }).records,
      ).toEqual([]);
      // another tenant with its own Ryze account: its bot cannot ask this gateway, and its emulator
      // (its tenant, its gateway) does not see this conversation's rows
      const t2 = await suDb.tenant.create({
        data: { name: "OUTRO", slug: `outro-${process.pid}` },
      });
      otherTenantId = t2.id;
      // Connecting registers the other number's webhook through the same fake; this suite's own route
      // must survive it.
      const ownHook = { ...hook };
      const view2 = await connectRyzeGateway(
        { tenantId: t2.id, userId: null, role: "TENANT_ADMIN" },
        {
          name: "Outro",
          baseUrl: outboundUrl("/"),
          instanceName: "outro",
          token: "tok2",
        },
        { makeRyzeClient: async () => fakeRyze() },
        appDb,
      );
      Object.assign(hook, ownHook);
      const agent2 = await suDb.agent.create({
        data: { tenantId: t2.id, name: "Outro", systemPrompt: "x" },
        select: { id: true },
      });
      const ctx2: TenantContext = {
        tenantId: t2.id,
        userId: null,
        role: "TENANT_ADMIN",
      };
      const inbox2 = await runScopedOn(appDb, ctx2, (db) =>
        db.inbox.findFirstOrThrow({
          where: { chatwootInstanceId: BigInt(view2.instanceId) },
        }),
      );
      await bindInbox(ctx2, inbox2.id, agent2.id, {}, appDb);
      const bot2 = await runScopedOn(appDb, ctx2, (db) =>
        db.chatwootAgentBot.findFirstOrThrow({
          where: { chatwootInstanceId: BigInt(view2.instanceId) },
        }),
      );
      const token2 = decryptJson<string>(bot2.accessToken);
      expect((await ask(conversationId, token2)).status).toBe(401);
      const emulator2 = new RyzeEmulator(t2.id, BigInt(view2.instanceId), {
        base: appDb,
      });
      const cross = await ask(conversationId, token2, emulator2);
      // that conversation number does not exist on tenant 2's gateway
      expect(cross.status).toBe(404);
    });

    // ── A11: native Chatwoot is decided exactly as before, whatever the page carries ──
    test("A11 native Chatwoot ignores forged Ryze states and keeps its read-back; the Ryze lookup refuses a native client", async () => {
      const page = [
        {
          id: 501,
          content: "resposta",
          message_type: 1,
          private: false,
          status: RYZE_STATUS_UNCERTAIN,
          content_attributes: {
            fazer_ai_send_id: "nativo-1",
            fazer_ai_ryze_delivery: "uncertain",
          },
          sender: { id: 9, type: "agent_bot" },
        },
      ];
      const native = new ChatwootClient(
        {
          baseUrl: "https://chat.example.com",
          accountId: 1,
          adminToken: "ADMIN",
          botToken: "BOT",
        },
        (async () =>
          Response.json({ payload: page })) as unknown as typeof fetch,
      );
      expect(native.isRyzeEmulator).toBe(false);
      expect(
        await accountForRejectedSend(
          native,
          77,
          "nativo-1",
          null,
          new ChatwootApiError(503, "POST"),
          undefined,
        ),
      ).toEqual({ known: true, id: 501 });
      // and a native 422 is still a proven pre-create rejection there
      expect(
        await accountForRejectedSend(
          native,
          77,
          "qualquer",
          null,
          new ChatwootApiError(422, "POST"),
          undefined,
        ),
      ).toEqual({ known: true, id: null });
      await expect(native.getRyzeSendState(77, "nativo-1")).rejects.toThrow(
        "not a RyzeAPI emulator client",
      );
    });

    // ── Runtime and flush, for real: model faked, provider faked, everything between them real ──

    test("A2/A10/A15 direct turn, split off, provider times out after taking the reply: no throw-path error, one provider call, the operator sees the unconfirmed-send badge, conversation not resolved", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
      });
      deliverMode = "process";
      processDeps = {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Te respondo já."] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      };
      reset(["accept-then-timeout"]);
      const { conversationId } = await inbound("quanto custa a expedição?");
      deliverMode = "capture";
      expect(provider.map((p) => p.text)).toEqual(["Te respondo já."]);
      const conv = await conversationRow(conversationId);
      expect(conv?.lastError).toContain(
        "o provedor do WhatsApp não confirmou o aceite",
      );
      expect(conv?.lastError).not.toContain("nenhum balão foi entregue");
      expect(conv?.status).not.toBe("resolved");
      // A15: the operator's conversation list carries it
      const listed = await listConversations(ctx(), {}, appDb);
      const item = listed.items.find((i) => String(i.id) === String(conv?.id));
      expect(item?.lastError).toContain("não confirmou o aceite");
      // the ledger row settled; nothing armed a recovery
      const recoveries = await runScopedOn(appDb, ctx(), (db) =>
        db.schedulerJob.count({
          where: { tenantId, kind: "DELIVERY_RECOVERY" },
        }),
      );
      expect(recoveries).toBe(0);
    });

    test("A1 runtime, split on: balloon 2 uncertain is not resent and the badge says unconfirmed", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: true },
      });
      deliverMode = "process";
      processDeps = {
        makeModel: () => new FakeListChatModel({ responses: [TWO_BALLOONS] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      };
      reset(["ok", "accept-then-reset"]);
      const { conversationId } = await inbound();
      deliverMode = "capture";
      expect(provider.map((p) => p.text)).toEqual([
        "Primeiro balão.",
        "Segundo balão.",
      ]);
      expect((await conversationRow(conversationId))?.lastError).toContain(
        "não confirmou o aceite",
      );
    });

    async function armedFlush(conversationId: number): Promise<ClaimedJob> {
      const row = await suDb.schedulerJob.findFirstOrThrow({
        where: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: { endsWith: `:${conversationId}` },
          status: "PENDING",
        },
      });
      const claimed = await suDb.schedulerJob.update({
        where: { id: row.id },
        data: { status: "CLAIMED", claimSeq: { increment: 1 } },
      });
      return {
        id: claimed.id,
        tenantId,
        kind: "DEBOUNCE",
        payload: claimed.payload as Record<string, unknown>,
        dedupeKey: claimed.dedupeKey ?? undefined,
        attempts: claimed.attempts,
        claimSeq: claimed.claimSeq,
      };
    }

    test("A10 flush, split off, uncertain send: the flush RESOLVES (no scheduler retry, so no second turn); control: a never-dispatched send makes it throw, which is what re-runs it", async () => {
      await setAgentSettings({ split: { enabled: false } });
      deliverMode = "process";
      processDeps = { checkpointer: new MemorySaver(), sleep: noSleep };
      const a = await inbound("primeira");
      const b = await inbound("segunda");
      deliverMode = "capture";
      const deps = {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Resposta do flush."] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      };
      reset(["accept-then-timeout"]);
      const outA = await flushDebounceJob({
        job: await armedFlush(a.conversationId),
        base: appDb,
        deps,
      });
      expect(outA.outcome).not.toBe("retry");
      expect(provider).toHaveLength(1);
      expect((await conversationRow(a.conversationId))?.lastError).toContain(
        "não confirmou o aceite",
      );
      // control: the provider is never called (the client cannot be built for the whole turn, typing
      // indicator included) — a proven absence, and the flush throws, which is what re-runs it
      reset([]);
      failMakeRyze = 1_000;
      try {
        await expect(
          flushDebounceJob({
            job: await armedFlush(b.conversationId),
            base: appDb,
            deps,
          }),
        ).rejects.toThrow("nenhum balão foi entregue");
      } finally {
        failMakeRyze = 0;
      }
      expect(provider).toHaveLength(0);
      const rowsB = await rowsOf(b.conversationId);
      expect(rowsB.map((r) => r.status)).toEqual([RYZE_STATUS_NOT_DISPATCHED]);
    });

    const IMG_BYTES = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const imageDeps = {
      fetchImpl: (async () =>
        new Response(IMG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        })) as unknown as typeof fetch,
      assertSafe: async (u: string) => new URL(u),
    };
    class SendImageOnly {
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        let k = 0;
        return {
          async invoke(): Promise<AIMessage> {
            k += 1;
            return k === 1
              ? new AIMessage({
                  content: "",
                  tool_calls: [
                    {
                      name: "send_image",
                      args: {
                        url: "https://cdn.loja.com.br/mapa.png",
                        caption: "Mapa",
                      },
                      id: "call_img",
                    },
                  ],
                })
              : new AIMessage("");
          },
        };
      }
    }

    test("A4 attachment-only turn, media uncertain: no throw-path error, one provider call, unconfirmed badge; control: never dispatched throws as before", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
        sendImage: { allowedHosts: ["cdn.loja.com.br"] },
      });
      deliverMode = "process";
      processDeps = {
        makeModel: () => new SendImageOnly() as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        sleep: noSleep,
        imageDeps,
      };
      reset(["accept-then-timeout"]);
      const a = await inbound("manda o mapa");
      expect(provider.map((p) => p.path)).toEqual(["/api/message/media"]);
      const convA = await conversationRow(a.conversationId);
      expect(convA?.lastError).toContain("não confirmou o aceite");
      expect(convA?.lastError).not.toContain("envio de anexo");
      const rowsA = await rowsOf(a.conversationId);
      expect(rowsA.map((r) => r.status)).toEqual([RYZE_STATUS_UNCERTAIN]);
      // the media bytes are kept with it
      const media = await runScopedOn(appDb, ctx(), (db) =>
        db.ryzeMedia.count({ where: { messageId: rowsA[0]?.messageId } }),
      );
      expect(media).toBe(1);

      reset([]);
      failMakeRyze = 1_000;
      let b: Awaited<ReturnType<typeof inbound>>;
      try {
        b = await inbound("manda o mapa de novo");
      } finally {
        failMakeRyze = 0;
      }
      deliverMode = "capture";
      expect(provider).toHaveLength(0);
      expect((await conversationRow(b.conversationId))?.lastError).toContain(
        "envio de anexo",
      );
    });

    let ttsKeyRef = "";
    const audioFetch = (async () =>
      new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      })) as unknown as typeof fetch;

    test("A5 audio reply uncertain: no fallback to text; control: a voice note never dispatched does fall back to text", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
        tts: { mode: "mirror", provider: "openai", credentialRef: ttsKeyRef },
      });
      const deps = {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Claro, vamos agendar."] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
        ttsFetch: audioFetch,
      };
      // Two conversations opened by text (answered by text: mirror mode answers text with text)
      deliverMode = "process";
      processDeps = deps;
      reset(["ok", "ok"]);
      const a = await inbound("oi");
      const b = await inbound("oi");
      deliverMode = "capture";
      // ...then a voice note from each customer, handed to the real runtime
      const asAudio = (
        e: NormalizedChatwootEvent,
      ): NormalizedChatwootEvent => ({
        ...e,
        message: {
          ...(e.message as NonNullable<NormalizedChatwootEvent["message"]>),
          id: ((e.message?.id as number) ?? 0) + 100_000,
          content: "",
          attachments: [
            { id: 5, fileType: "audio", dataUrl: "https://203.0.113.10/a.ogg" },
          ],
          transcribedText: "quero agendar",
        },
      });
      reset(["accept-then-timeout"]);
      const outA = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId,
        event: asAudio(a.event),
        base: appDb,
        deps,
      });
      expect(provider.map((p) => p.path)).toEqual(["/api/message/media"]);
      expect(outA).toBe("posted-partial");
      expect((await conversationRow(a.conversationId))?.lastError).toContain(
        "não confirmou o aceite",
      );
      // control: the client cannot be built at all, so the voice note provably never left — the turn
      // then tries the text, as it always did (which here cannot leave either, and the turn throws)
      reset([]);
      failMakeRyze = 1_000;
      try {
        await expect(
          runAgentTurn({
            tenantId,
            instanceId,
            agentBotId,
            event: asAudio(b.event),
            base: appDb,
            deps,
          }),
        ).rejects.toThrow("nenhum balão foi entregue");
      } finally {
        failMakeRyze = 0;
      }
      expect(provider).toHaveLength(0);
      const rowsB = (await rowsOf(b.conversationId)).filter(
        (r) => r.status === RYZE_STATUS_NOT_DISPATCHED,
      );
      // the voice note AND the text fallback, each kept as never dispatched
      expect(rowsB.map((r) => r.content)).toEqual([
        null,
        "Claro, vamos agendar.",
      ]);
    });

    // ── memory: the next turn is told, the history is not touched ──
    // What the model was handed as this turn's customer message.
    class InputCapturingModel extends FakeListChatModel {
      seen: string[] = [];
      override bindTools() {
        return this;
      }
      override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const last = messages.filter((m) => m.getType() === "human").at(-1);
        this.seen.push(typeof last?.content === "string" ? last.content : "");
        return {
          generations: [{ text: "Ok.", message: new AIMessage("Ok.") }],
        };
      }
    }

    test("memory: after an unconfirmed reply the next turn carries the note; once a later send is accepted it does not; the stored thread keeps the original reply", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
      });
      const saver = new MemorySaver();
      deliverMode = "process";
      processDeps = {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Resposta talvez entregue."] }),
        checkpointer: saver,
        sleep: noSleep,
      };
      reset(["accept-then-timeout"]);
      const first = await inbound("pergunta 1");
      const model2 = new InputCapturingModel({ responses: ["Ok."] });
      processDeps = {
        makeModel: () => model2,
        checkpointer: saver,
        sleep: noSleep,
      };
      reset(["ok"]);
      // a second message of the SAME customer: same conversation
      jidSeq -= 1;
      await inbound("pergunta 2");
      const model3 = new InputCapturingModel({ responses: ["Ok."] });
      processDeps = {
        makeModel: () => model3,
        checkpointer: saver,
        sleep: noSleep,
      };
      reset(["ok"]);
      jidSeq -= 1;
      await inbound("pergunta 3");
      deliverMode = "capture";
      expect(model2.seen.at(-1)).toContain("pergunta 2");
      expect(model2.seen.at(-1)).toContain("<envio_nao_confirmado>");
      expect(model3.seen.at(-1)).toContain("pergunta 3");
      expect(model3.seen.at(-1)).not.toContain("<envio_nao_confirmado>");
      // the uncertain attempt is still on record, untouched
      const rows = await rowsOf(first.conversationId);
      expect(rows.map((r) => [r.content, r.status])).toContainEqual([
        "Resposta talvez entregue.",
        RYZE_STATUS_UNCERTAIN,
      ]);
    });

    // ── L-F: the follow-up ladder does not build on a word the provider never took ──
    test("L-F follow-up: an unconfirmed reply ends the episode with a stamp — no nudge, label or resolve, no sweep loop — and the customer's next message is handled and opens a new episode", async () => {
      registerFollowUpHandlers();
      const sweepJobId = await burnSchedulerJobId(suDb);
      await suDb.agent.update({
        where: { id: agentId },
        data: { followUpArmedAt: new Date(Date.now() - 24 * 60 * 60_000) },
      });
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
        followUp: {
          enabled: true,
          steps: [
            {
              delayValue: 1,
              delayUnit: "minutes",
              instructions: "pergunte se ainda tem interesse",
              assignLabels: ["sem_resposta"],
              resolve: true,
            },
          ],
        },
      });
      const turnDeps = (reply: string): RuntimeDeps => ({
        makeModel: () => new FakeListChatModel({ responses: [reply] }),
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      });
      // 1. the customer writes; the reply's acceptance is lost
      deliverMode = "process";
      processDeps = turnDeps("Te mando os valores.");
      reset(["accept-then-timeout"]);
      const first = await inbound("quero os valores");
      deliverMode = "capture";
      const conversationId = first.conversationId;
      const threadId = `${tenantId}:${instanceId}:${conversationId}`;
      const keyOf = `followup:${threadId}`;
      // the conversation then goes quiet past the step's delay
      const idle = async () => {
        const past = new Date(Date.now() - 5 * 60_000);
        await suDb.conversation.updateMany({
          where: { tenantId, threadId },
          data: {
            lastEventAt: past,
            lastInboundAt: past,
            lastRepliedAt: past,
          },
        });
      };
      await idle();
      const sweep = async () => {
        const handler = getJobHandler("FOLLOWUP_SWEEP");
        if (!handler)
          throw new Error("unreachable: registerFollowUpHandlers ran");
        await handler(
          {
            id: sweepJobId,
            tenantId,
            kind: "FOLLOWUP_SWEEP",
            payload: {},
            attempts: 0,
            claimSeq: 0,
          },
          appDb,
        );
      };
      const claimFollowUp = async (): Promise<ClaimedJob | null> => {
        const row = await suDb.schedulerJob.findFirst({
          where: {
            tenantId,
            kind: "FOLLOWUP",
            dedupeKey: keyOf,
            status: "PENDING",
          },
        });
        if (!row) return null;
        const claimed = await suDb.schedulerJob.update({
          where: { id: row.id },
          data: { status: "CLAIMED", claimSeq: { increment: 1 } },
        });
        return {
          id: claimed.id,
          tenantId,
          kind: "FOLLOWUP",
          payload: claimed.payload as Record<string, unknown>,
          dedupeKey: claimed.dedupeKey ?? undefined,
          attempts: claimed.attempts,
          claimSeq: claimed.claimSeq,
        };
      };
      const nudgeDeps = turnDeps("Ainda tem interesse?");
      // 2. the sweep offers it, and the handler ends it before any nudge
      await sweep();
      const job = await claimFollowUp();
      if (!job)
        throw new Error("the sweep should have armed the episode's step 0");
      providerPaths.length = 0;
      reset([]);
      const out = await followUpHandler(job, appDb, nudgeDeps);
      expect(out).toEqual({ outcome: "done" });
      // nothing reached RyzeAPI at all: no nudge, no label assignment, no presence
      expect(provider).toEqual([]);
      expect(providerPaths).toEqual([]);
      const after = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, threadId },
        select: { lastFollowUpAt: true, status: true },
      });
      // the episode is closed by its watermark, and the conversation stays open with no new label
      expect(after.lastFollowUpAt).not.toBeNull();
      expect(after.status).not.toBe("resolved");
      const ryzeConv = await runScopedOn(appDb, ctx(), (db) =>
        db.ryzeConversation.findFirstOrThrow({
          where: { gatewayId, displayId: conversationId },
          select: { labels: true, status: true },
        }),
      );
      expect(ryzeConv.labels).not.toContain("sem_resposta");
      expect(ryzeConv.status).not.toBe("resolved");
      // 3. the next sweep does not bring it back (no loop)
      await suDb.schedulerJob.updateMany({
        where: {
          tenantId,
          kind: "FOLLOWUP",
          dedupeKey: keyOf,
          status: "CLAIMED",
        },
        data: { status: "DONE" },
      });
      await sweep();
      expect(await claimFollowUp()).toBeNull();
      // 4. the customer writes again: handled as always (a turn runs, its reply is accepted)
      deliverMode = "process";
      processDeps = turnDeps("Os valores são estes.");
      reset(["ok"]);
      jidSeq -= 1;
      const second = await inbound("e aí?");
      deliverMode = "capture";
      expect(second.conversationId).toBe(conversationId);
      expect(accepted()).toEqual(["Os valores são estes."]);
      // 5. a new silence opens a new episode, and with the latest reply accepted the nudge goes out.
      // Moved back in time WITH its order kept: the stamp of step 2, then the customer's message.
      await idle();
      await suDb.conversation.updateMany({
        where: { tenantId, threadId },
        data: { lastFollowUpAt: new Date(Date.now() - 10 * 60_000) },
      });
      await sweep();
      const job2 = await claimFollowUp();
      if (!job2) throw new Error("a new inbound should open a new episode");
      reset(["ok"]);
      const out2 = await followUpHandler(job2, appDb, nudgeDeps);
      expect(out2.outcome).toBe("done");
      expect(accepted()).toEqual(["Ainda tem interesse?"]);
    });

    test("deferred resolve: a turn that asked to resolve but whose reply is unconfirmed leaves the conversation open; control: an accepted reply does resolve", async () => {
      await setAgentSettings({
        debounce: { enabled: false },
        split: { enabled: false },
      });
      deliverMode = "process";
      processDeps = {
        makeModel: () =>
          new ResolveThenReplyModel(
            "Resolvido, obrigado!",
          ) as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      };
      reset(["accept-then-timeout"]);
      const a = await inbound("era só isso");
      processDeps = {
        makeModel: () =>
          new ResolveThenReplyModel(
            "Resolvido, obrigado!",
          ) as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
        sleep: noSleep,
      };
      reset(["ok"]);
      const b = await inbound("era só isso também");
      deliverMode = "capture";
      const ryzeStatus = (cid: number) =>
        runScopedOn(appDb, ctx(), (db) =>
          db.ryzeConversation.findFirstOrThrow({
            where: { gatewayId, displayId: cid },
            select: { status: true },
          }),
        );
      expect((await ryzeStatus(a.conversationId)).status).not.toBe("resolved");
      expect((await conversationRow(a.conversationId))?.lastError).toContain(
        "não confirmou o aceite",
      );
      expect((await ryzeStatus(b.conversationId)).status).toBe("resolved");
    });
  },
);

let otherTenantId = 0n;
