import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contentToText } from "@/graph/message-text";
import { runAgentTurn } from "@/graph/runtime";
import { buildThreadStateGraph } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { JEV_RETRY_FALLBACK, JEV_RETRY_MARK } from "@/modules/jev/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { ScriptedSilenceModel } from "../utils/scripted-models";

// Jev around a real turn, against a fake TypeSafe API: (1) an answer to the agent's question is not
// a bare acknowledgement, so the model runs; (2) outputCheck.onBreak "retry" asks the model once more
// instead of handing the conversation over, and a second break sends the fallback line.

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

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;

const RULES = "diz que registrou ou salvou algo sem ter chamado a ferramenta";

// The fake Jev: the ack question answers `ack`; the rule check says a reply breaks the rules when
// it carries "Registrei".
function fakeJev(ack: number) {
  const states: string[] = [];
  const fetchImpl = (async (_: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: string;
      questions: Record<string, unknown>;
    };
    states.push(body.state);
    const answers = body.questions.breaks
      ? {
          breaks: {
            type: "noul",
            noul: body.state.includes("Registrei") ? 0.97 : 0.02,
          },
        }
      : {
          ack: { type: "noul", noul: ack },
          human: { type: "noul", noul: 0.01 },
          frustration: { type: "score", score: 0, confidence: 1 },
        };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { states, deps: { fetchImpl, apiKey: "k" } };
}

type Call = [string, ...unknown[]];

function makeClient(calls: Call[], page: unknown[]) {
  const client = {
    sendMessage: async (conversationId: number, content: string) => {
      calls.push(["sendMessage", conversationId, content]);
      return {};
    },
    sendPrivateNote: async (conversationId: number, content: string) => {
      calls.push(["sendPrivateNote", conversationId, content]);
      return {};
    },
    toggleStatus: async (conversationId: number, status: string) => {
      calls.push(["toggleStatus", conversationId, status]);
      return {};
    },
    getMessages: async () => page,
    getLatestIncomingMessage: async () => ({ id: 77, isReaction: false }),
    addMessageReaction: async (conv: number, id: number, emoji: string) => {
      calls.push(["reaction", conv, id, emoji]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const outgoing = (id: number, content: string) => ({
  id,
  content,
  message_type: 1,
  private: false,
});

const incoming = (
  convId: number,
  content: string,
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: { id: 77, content, messageType: "incoming", private: false },
});

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

async function setJev(outputCheck: Record<string, unknown> | null) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings: {
        split: { enabled: false },
        limits: { retrySilence: false },
        jev: {
          enabled: true,
          ...(outputCheck
            ? {
                outputCheck: {
                  enabled: true,
                  instructions: RULES,
                  ...outputCheck,
                },
              }
            : {}),
        },
      },
    },
  });
}

async function jevDetails(convId: number) {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  const rows = await flowLogRows(suDb, {
    where: { tenantId, conversationId: conv.id, stage: "jev" },
    orderBy: { id: "asc" },
    select: { detail: true },
  });
  return rows.map((r) => r.detail as Record<string, unknown>);
}

async function turn(
  convId: number,
  text: string,
  model: ScriptedSilenceModel,
  jev: ReturnType<typeof fakeJev>,
  page: unknown[] = [],
) {
  await seedConversation(convId);
  const calls: Call[] = [];
  const checkpointer = new MemorySaver();
  const outcome = await runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: 9,
    event: incoming(convId, text),
    base: appDb,
    deps: {
      makeModel: () => model as unknown as BaseChatModel,
      makeClient: makeClient(calls, page),
      checkpointer,
      jev: jev.deps,
    },
  });
  const state = await buildThreadStateGraph(checkpointer).getState({
    configurable: { thread_id: `${tenantId}:${instanceId}:${convId}` },
  });
  const thread = (
    (state.values as { messages?: BaseMessage[] }).messages ?? []
  ).map((m) => contentToText(m.content));
  return { outcome, calls, thread };
}

describe.skipIf(!dbUp)("Jev around a turn", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "JEV", slug: `jev-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Maria",
        systemPrompt: "Você é a assistente.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `jev-route-${process.pid}`,
        name: "Maria",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "llm_usage",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("'Sim' after the agent's question reaches the model", async () => {
    await setJev(null);
    const model = new ScriptedSilenceModel([{ text: "Combinado, adiantei!" }]);
    const jev = fakeJev(0.97);
    const { outcome, calls } = await turn(9101, "Sim", model, jev, [
      outgoing(10, "Quer adiantar o pedido?"),
      { id: 11, content: "Sim", message_type: 0, private: false },
    ]);
    expect(outcome).toBe("posted");
    expect(model.seen).toHaveLength(1);
    expect(calls).toEqual([["sendMessage", 9101, "Combinado, adiantei!"]]);
    // The question travelled as context of the reading.
    expect(jev.states[0]).toContain("Quer adiantar o pedido?");
    expect((await jevDetails(9101))[0]?.agentAsked).toBe(true);
  });

  test("'ok obrigada' after a statement is a reaction and no model call", async () => {
    await setJev(null);
    const model = new ScriptedSilenceModel([{ text: "nunca" }]);
    const { outcome, calls } = await turn(
      9102,
      "ok obrigada",
      model,
      fakeJev(0.97),
      [outgoing(20, "Pronto, registrei a venda.")],
    );
    expect(outcome).toBe("blocked");
    expect(model.seen).toHaveLength(0);
    expect(calls).toEqual([["reaction", 9102, 77, "👍"]]);
  });

  test("with no history the acknowledgement works as before", async () => {
    await setJev(null);
    const model = new ScriptedSilenceModel([{ text: "nunca" }]);
    const jev = fakeJev(0.97);
    const { outcome } = await turn(9103, "valeu", model, jev, []);
    expect(outcome).toBe("blocked");
    expect(model.seen).toHaveLength(0);
    expect(jev.states[0]).toBe("Mensagem do cliente:\nvaleu");
  });

  test("onBreak retry: the model corrects itself and nobody is called", async () => {
    await setJev({ onBreak: "retry" });
    const model = new ScriptedSilenceModel([
      { text: "Registrei a venda de 250!" },
      { text: "Ainda não salvei: me confirma a data da venda?" },
    ]);
    const jev = fakeJev(0);
    const { outcome, calls } = await turn(9104, "vendi 250", model, jev);
    expect(outcome).toBe("posted");
    expect(model.seen).toHaveLength(2);
    const note = contentToText(model.seen[1]?.at(-1)?.content ?? "");
    expect(note).toContain(JEV_RETRY_MARK);
    expect(note).toContain(RULES);
    expect(calls).toEqual([
      ["sendMessage", 9104, "Ainda não salvei: me confirma a data da venda?"],
    ]);
    // The check knew no tool ran.
    expect(jev.states.at(-1)).toContain("neste turno: nenhuma.");
    const details = await jevDetails(9104);
    expect(details).toContainEqual({
      outputCheck: 0.97,
      held: true,
      retried: true,
    });
    expect(details).toContainEqual({
      outputCheck: 0.02,
      held: false,
      retried: true,
    });
  });

  test("onBreak retry: a second break sends the fallback, still no transfer", async () => {
    await setJev({ onBreak: "retry" });
    const model = new ScriptedSilenceModel([
      { text: "Registrei a venda!" },
      { text: "Registrei sim, pode ficar tranquila." },
    ]);
    const { outcome, calls, thread } = await turn(
      9105,
      "vendi 250",
      model,
      fakeJev(0),
    );
    expect(outcome).toBe("posted");
    expect(model.seen).toHaveLength(2);
    expect(calls).toEqual([["sendMessage", 9105, JEV_RETRY_FALLBACK]]);
    // Neither held reply stays in the thread the next turn reads.
    expect(thread.some((t) => t.includes("Registrei"))).toBe(false);
    expect((await jevDetails(9105)).at(-1)).toEqual({
      outputCheck: 0.97,
      held: true,
      retried: true,
    });
  });

  test("onBreak handoff (default): unchanged, the team takes the case", async () => {
    await setJev({});
    const model = new ScriptedSilenceModel([{ text: "Registrei a venda!" }]);
    const jev = fakeJev(0);
    const { calls } = await turn(9106, "vendi 250", model, jev);
    // Asked exactly what it was asked before: the reply alone.
    expect(jev.states.at(-1)).toBe(
      "Resposta que o atendente virtual vai enviar ao cliente:\nRegistrei a venda!",
    );
    expect(model.seen).toHaveLength(1);
    expect(calls).toContainEqual(["toggleStatus", 9106, "open"]);
    expect(calls.at(-1)).toEqual([
      "sendMessage",
      9106,
      "Deixa eu confirmar isso com a equipe e já te respondo aqui 🙏",
    ]);
    expect((await jevDetails(9106)).at(-1)).toEqual({
      outputCheck: 0.97,
      held: true,
    });
  });
});
