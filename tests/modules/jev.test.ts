import { describe, expect, test } from "bun:test";
import {
  isBareAcknowledgement,
  JEV_URL,
  readCustomerMessage,
  readingNote,
  readJevConfig,
  replyBreaksRules,
} from "@/modules/jev/service";

// Jev (TypeSafe AI) against a fake API: the shapes are the ones the real one answered on 02/10/2026.

const cfg = readJevConfig({
  jev: {
    enabled: true,
    intents: {
      comprar: "Quer pedir ou ver oferta",
      pedido_feito: "Fala de um pedido já feito",
    },
    outputCheck: {
      enabled: true,
      instructions: "promete cupom, cashback ou frete grátis",
    },
  },
});
if (!cfg) throw new Error("config should load");

function fakeJev(answers: Record<string, unknown>, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), {
      status,
    });
  }) as typeof fetch;
  return { calls, deps: { fetchImpl, apiKey: "k" } };
}

describe("readJevConfig", () => {
  test("off unless enabled; thresholds default and stay inside 0..1", () => {
    expect(readJevConfig({})).toBeNull();
    expect(readJevConfig({ jev: { enabled: false } })).toBeNull();
    const c = readJevConfig({ jev: { enabled: true, ackThreshold: 7 } });
    expect(c?.ackThreshold).toBe(0.9);
    expect(c?.intents).toEqual({});
    expect(c?.outputCheck.enabled).toBe(false); // no rules written = no check
  });
});

describe("the reading before the model", () => {
  test("asks every question in one call and reads the typed answers", async () => {
    const { calls, deps } = fakeJev({
      ack: { type: "noul", noul: 0.01 },
      human: { type: "noul", noul: 0.98 },
      frustration: { type: "score", score: 2, confidence: 1 },
      intent: { type: "choice", choice: "pedido_feito", confidence: 0.98 },
    });
    const r = await readCustomerMessage(
      cfg,
      "cadê meu pedido!!! quero o dono",
      deps,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(JEV_URL);
    expect(Object.keys(calls[0]?.body.questions as object).sort()).toEqual([
      "ack",
      "frustration",
      "human",
      "intent",
    ]);
    expect(r).toMatchObject({
      human: 0.98,
      frustration: 2,
      intent: "pedido_feito",
    });
    const note = readingNote(cfg, r as NonNullable<typeof r>) ?? "";
    expect(note).toContain("PEDIU UMA PESSOA");
    expect(note).toContain("BRAVO");
    expect(note).toContain("pedido_feito");
  });

  test("a bare 'valeu' is an acknowledgement; a long or asking message is not", async () => {
    const { deps } = fakeJev({
      ack: { type: "noul", noul: 0.97 },
      human: { type: "noul", noul: 0.02 },
      frustration: { type: "score", score: 0, confidence: 1 },
    });
    const r = await readCustomerMessage(cfg, "valeu 👍", deps);
    if (!r) throw new Error("reading expected");
    expect(isBareAcknowledgement(cfg, r, "valeu 👍")).toBe(true);
    expect(isBareAcknowledgement(cfg, r, "valeu! ".repeat(20))).toBe(false);
    expect(isBareAcknowledgement(cfg, { ...r, human: 0.8 }, "valeu")).toBe(
      false,
    );
    expect(readingNote(cfg, r)).toBeNull(); // calm and no clear intent: nothing to add
  });

  test("an error, a timeout or no key is no reading, never a failed turn", async () => {
    expect(
      await readCustomerMessage(cfg, "oi", fakeJev({}, 500).deps),
    ).toBeNull();
    const broken = {
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("timeout");
      }) as unknown as typeof fetch,
    };
    expect(await readCustomerMessage(cfg, "oi", broken)).toBeNull();
    expect(await readCustomerMessage(cfg, "oi", { apiKey: "" })).toBeNull();
  });
});

describe("the rule check after the model", () => {
  test("returns the probability the reply breaks the rules", async () => {
    const { calls, deps } = fakeJev({ breaks: { type: "noul", noul: 0.94 } });
    expect(await replyBreaksRules(cfg, "Te dou um cupom de 20%!", deps)).toBe(
      0.94,
    );
    if (!calls[0]) throw new Error("Expected a Jev request");
    const q = (
      calls[0].body.questions as Record<string, { instructions: string }>
    ).breaks;
    expect(q?.instructions).toContain("promete cupom");
  });

  test("does not run without rules or on an empty reply", async () => {
    const off = readJevConfig({ jev: { enabled: true } });
    if (!off) throw new Error("config should load");
    const { calls, deps } = fakeJev({ breaks: { type: "noul", noul: 0.9 } });
    expect(await replyBreaksRules(off, "qualquer", deps)).toBeNull();
    expect(await replyBreaksRules(cfg, "  ", deps)).toBeNull();
    expect(calls.length).toBe(0);
  });
});
