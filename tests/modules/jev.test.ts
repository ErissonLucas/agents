import { describe, expect, test } from "bun:test";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import {
  agentAsked,
  isBareAcknowledgement,
  JEV_RETRY_FALLBACK,
  JEV_RETRY_MARK,
  JEV_URL,
  lastAgentMessage,
  readCustomerMessage,
  readingNote,
  readJevConfig,
  replyBreaksRules,
  retryNote,
  stripForeignScripts,
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

describe("an answer to our question is not an acknowledgement", () => {
  const row = (
    id: number,
    messageType: ChatwootMessageRow["messageType"],
    content: string,
    over: Partial<ChatwootMessageRow> = {},
  ) =>
    ({
      id,
      content,
      messageType,
      private: false,
      isReaction: false,
      ...over,
    }) as ChatwootMessageRow;

  test("the last agent message is the newest public outgoing one with text", () => {
    expect(lastAgentMessage([])).toBeNull();
    expect(
      lastAgentMessage([
        row(1, "outgoing", "Quer adiantar o pedido?"),
        row(2, "outgoing", "nota interna", { private: true }),
        row(3, "incoming", "sim"),
        row(4, "activity", "Conversa atribuída"),
      ]),
    ).toBe("Quer adiantar o pedido?");
    expect(
      lastAgentMessage([
        row(5, "outgoing", "Qual o valor?"),
        row(6, "template", "Pedido confirmado."),
      ]),
    ).toBe("Pedido confirmado.");
  });

  test("'Sim' after a question goes to the model; 'ok obrigada' after a statement is a reaction", async () => {
    const { deps } = fakeJev({
      ack: { type: "noul", noul: 0.96 },
      human: { type: "noul", noul: 0.01 },
    });
    const r = await readCustomerMessage(cfg, "Sim", deps);
    if (!r) throw new Error("reading expected");
    expect(
      isBareAcknowledgement(cfg, r, "Sim", "Quer adiantar o pedido?"),
    ).toBe(false);
    expect(
      isBareAcknowledgement(cfg, r, "250", "Qual o valor da venda? Me fala"),
    ).toBe(false);
    expect(
      isBareAcknowledgement(
        cfg,
        r,
        "ok obrigada",
        "Pronto, registrei a venda.",
      ),
    ).toBe(true);
    // No history: as before.
    expect(isBareAcknowledgement(cfg, r, "ok obrigada", null)).toBe(true);
    expect(isBareAcknowledgement(cfg, r, "ok obrigada")).toBe(true);
    expect(agentAsked("¿Seguimos?")).toBe(true);
    expect(agentAsked("Feito.")).toBe(false);
  });

  test("the agent's last message travels as context of the ack question", async () => {
    const { calls, deps } = fakeJev({ ack: { type: "noul", noul: 0.1 } });
    await readCustomerMessage(cfg, "Outubro", deps, {
      lastAgentMessage: "Para qual mês é a venda?",
    });
    const body = calls[0]?.body as {
      state: string;
      questions: Record<string, { instructions: string }>;
    };
    expect(body.state).toContain(
      "Última mensagem do atendente:\nPara qual mês é a venda?",
    );
    expect(body.state).toContain("Mensagem do cliente:\nOutubro");
    expect(body.questions.ack?.instructions).toContain("NÃO é só confirmação");
    // Without it the state is the customer's message alone, as before.
    const plain = fakeJev({ ack: { type: "noul", noul: 0.1 } });
    await readCustomerMessage(cfg, "Outubro", plain.deps);
    expect(plain.calls[0]?.body.state).toBe("Mensagem do cliente:\nOutubro");
  });
});

describe("outputCheck.onBreak and humanThreshold", () => {
  test("onBreak defaults to handoff; retry carries its fallback", () => {
    expect(cfg.outputCheck.onBreak).toBe("handoff");
    const retry = readJevConfig({
      jev: {
        enabled: true,
        outputCheck: {
          enabled: true,
          instructions: "diz que registrou sem chamar a ferramenta",
          onBreak: "retry",
        },
      },
    });
    expect(retry?.outputCheck.onBreak).toBe("retry");
    expect(retry?.outputCheck.retryFallback).toBe(JEV_RETRY_FALLBACK);
    const custom = readJevConfig({
      jev: {
        enabled: true,
        outputCheck: {
          onBreak: "nonsense",
          retryFallback: "  Tenta de novo  ",
        },
      },
    });
    expect(custom?.outputCheck.onBreak).toBe("handoff");
    expect(custom?.outputCheck.retryFallback).toBe("Tenta de novo");
  });

  test("the retry note names the rule and summarises the held reply", () => {
    const note = retryNote(cfg, "Te dou um cupom de 20%! ".repeat(40));
    expect(note.startsWith(JEV_RETRY_MARK)).toBe(true);
    expect(note).toContain("promete cupom");
    expect(note).toContain("Te dou um cupom");
    expect(note.length).toBeLessThan(1000);
  });

  test("humanThreshold above 1 turns the 'asked for a person' note off", () => {
    const off = readJevConfig({ jev: { enabled: true, humanThreshold: 2 } });
    if (!off) throw new Error("config should load");
    expect(off.humanThreshold).toBe(2);
    const reading = {
      ack: 0,
      human: 1,
      frustration: 0,
      frustrationConfidence: 1,
      intent: null,
      intentConfidence: 0,
    };
    expect(readingNote(off, reading)).toBeNull();
    expect(readingNote(cfg, reading)).toContain("PEDIU UMA PESSOA");
    // Zero, negative or not a number still fall back to the default.
    expect(
      readJevConfig({ jev: { enabled: true, humanThreshold: 0 } })
        ?.humanThreshold,
    ).toBe(0.9);
  });
});

describe("the rule check after the model", () => {
  test("returns the probability the reply breaks the rules", async () => {
    const { calls, deps } = fakeJev({ breaks: { type: "noul", noul: 0.94 } });
    expect(await replyBreaksRules(cfg, "Te dou um cupom de 20%!", deps)).toBe(
      0.94,
    );
    const body = calls[0]?.body as
      | { questions: Record<string, { instructions: string }> }
      | undefined;
    const q = body?.questions.breaks;
    expect(q?.instructions).toContain("promete cupom");
  });

  test("in retry mode the check is told which tools ran this turn", async () => {
    const { calls, deps } = fakeJev({ breaks: { type: "noul", noul: 0.1 } });
    await replyBreaksRules(cfg, "Registrei.", deps, { toolsCalled: [] });
    await replyBreaksRules(cfg, "Registrei.", deps, {
      toolsCalled: ["registrar_venda", "set_labels"],
    });
    await replyBreaksRules(cfg, "Registrei.", deps);
    const states = calls.map((c) => c.body.state as string);
    expect(states[0]).toContain("neste turno: nenhuma.");
    expect(states[1]).toContain("neste turno: registrar_venda, set_labels.");
    expect(states[2]).toBe(
      "Resposta que o atendente virtual vai enviar ao cliente:\nRegistrei.",
    );
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

describe("stripForeignScripts", () => {
  test("drops a leaked Gujarati word, keeps accents, emoji and line breaks", () => {
    expect(stripForeignScripts("Opa, Erisson! 😊 Não consigo agora. જરૂર")).toBe(
      "Opa, Erisson! 😊 Não consigo agora.",
    );
    expect(stripForeignScripts("R$ 47,99 🔥\nQual vai ser?")).toBe(
      "R$ 47,99 🔥\nQual vai ser?",
    );
    expect(stripForeignScripts("ação, coração — 2× fritas")).toBe(
      "ação, coração — 2× fritas",
    );
  });
});
