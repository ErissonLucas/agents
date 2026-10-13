import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { ScriptedSilenceModel } from "../utils/scripted-models";

// Jev outputCheck.onBreak "retry", graph side: a final answer the caller holds is neither sent nor
// persisted, and the model is asked once more in the same round with the caller's note as a late
// system message. Once per invocation; the second answer is the caller's to check again.

const NOTE = "[Sistema] Sua resposta anterior foi barrada (teste)";

const labels = tool(async () => "feito", {
  name: "set_labels",
  description: "labels",
  schema: z.object({}),
});

async function run(
  model: ScriptedSilenceModel,
  checkReply?: (text: string, tools: string[]) => Promise<string | null>,
  opts: { provider?: string; maxToolCalls?: number } = {},
) {
  const graph = buildAgentGraph({
    primary: { provider: opts.provider ?? "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [labels],
    checkReply,
    maxToolCalls: opts.maxToolCalls,
  });
  const out = await graph.invoke(
    { messages: [new HumanMessage("vendi 250 pra Ana")] },
    { configurable: { thread_id: "t-jev" } },
  );
  return out.messages as BaseMessage[];
}

const text = (m: BaseMessage | undefined) =>
  contentToText(m?.content ?? "").trim();

describe("the held reply's retry (Jev onBreak retry)", () => {
  test("a held answer is asked again once; only the second is persisted", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Registrei a venda!" },
      { text: "Ainda não registrei: qual a data?" },
    ]);
    const asked: string[] = [];
    const messages = await run(model, async (t) => {
      asked.push(t);
      return t.startsWith("Registrei") ? NOTE : null;
    });
    expect(model.seen).toHaveLength(2);
    expect(asked).toEqual(["Registrei a venda!"]); // once per invocation
    expect(messages.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect(text(messages.at(-1))).toBe("Ainda não registrei: qual a data?");
    const second = model.seen[1] ?? [];
    expect(second.at(-1)?.getType()).toBe("system");
    expect(text(second.at(-1))).toBe(NOTE);
    // The held words are not sent back, and the note is never a human message.
    expect(second.some((m) => text(m).includes("Registrei a venda"))).toBe(
      false,
    );
    expect(
      second.some((m) => m.getType() === "human" && text(m).includes(NOTE)),
    ).toBe(false);
  });

  test("the retry may call the tool it skipped, and the turn goes on", async () => {
    const model = new ScriptedSilenceModel([
      { text: "Registrei a venda!" },
      { text: "", calls: [{ name: "set_labels", args: {} }] },
      { text: "Pronto, registrado." },
    ]);
    const messages = await run(model, async (t) =>
      t.startsWith("Registrei") ? NOTE : null,
    );
    expect(model.seen).toHaveLength(3);
    expect(messages.map((m) => m.getType())).toEqual([
      "human",
      "ai",
      "tool",
      "ai",
    ]);
    expect(text(messages.at(-1))).toBe("Pronto, registrado.");
  });

  test("where a late system message is not accepted, the note rides in the system prompt", async () => {
    const model = new ScriptedSilenceModel([{ text: "x" }, { text: "y" }]);
    await run(model, async () => NOTE, { provider: "google" });
    const second = model.seen[1] ?? [];
    expect(second.filter((m) => m.getType() === "system")).toHaveLength(1);
    expect(text(second[0])).toContain(NOTE);
  });

  test("no hook, or a hook that lets it through, changes nothing", async () => {
    const a = new ScriptedSilenceModel([{ text: "Oi!" }]);
    expect(text((await run(a)).at(-1))).toBe("Oi!");
    expect(a.seen).toHaveLength(1);
    const b = new ScriptedSilenceModel([{ text: "Oi!" }]);
    expect(text((await run(b, async () => null)).at(-1))).toBe("Oi!");
    expect(b.seen).toHaveLength(1);
  });

  test("an answer that calls tools or says nothing is not checked", async () => {
    const model = new ScriptedSilenceModel([
      { text: "vou ver", calls: [{ name: "set_labels", args: {} }] },
      { text: "Feito." },
    ]);
    const asked: Array<[string, string[]]> = [];
    await run(model, async (t, tools) => {
      asked.push([t, tools]);
      return null;
    });
    // Checked once, on the final answer, knowing which tools ran before it.
    expect(asked).toEqual([["Feito.", ["set_labels"]]]);
  });
});
