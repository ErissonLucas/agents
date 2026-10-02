import logger from "@/api/lib/logger";
import config from "@/config";
import { clipText } from "@/lib/text";

// Jev (TypeSafe AI's System One model): fast, typed decisions with calibrated confidence, no text. It
// reads the customer's message BEFORE the agent's model runs and the agent's reply BEFORE it is sent,
// so the cheap yes/no questions stop costing a whole LLM turn:
//   - a bare "ok"/"valeu"/sticker gets a reaction and no reply (no model call at all);
//   - asking for a person, frustration and intent reach the model as a short reading it acts on;
//   - a reply that promises what the operator's rules forbid is held back and the case goes to the team.
// Best-effort by construction: no key, a timeout, an HTTP error or an answer it cannot read all return
// null and the turn runs exactly as it would without Jev.

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 2_500;
// The reading looks at the customer's latest words, not the whole thread (Jev's window is ~60k tokens
// and the question is about this message).
const STATE_MAX_CHARS = 4_000;

export interface JevConfig {
  enabled: boolean;
  // Above this, a message that is only an acknowledgement is answered with a reaction and no reply.
  ackThreshold: number;
  // Above this, "asked for a person" is told to the model as a must-act (transfer now).
  humanThreshold: number;
  // The intents the reading names, `name: description` (the agent's own vocabulary). Empty = no intent.
  intents: Record<string, string>;
  // The emoji the acknowledgement gets.
  ackEmoji: string;
  outputCheck: {
    enabled: boolean;
    // The operator's rules a reply must not break, in plain words ("promete cupom, cashback, frete
    // grátis ou prazo exato…").
    instructions: string;
    threshold: number;
    // What the customer reads when a reply is held back and the case goes to the team.
    handoffMessage: string;
  };
}

const num = (v: unknown, d: number) =>
  typeof v === "number" && v > 0 && v <= 1 ? v : d;

export function readJevConfig(settings: unknown): JevConfig | null {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).jev
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  if (j.enabled !== true) return null;
  const intents: Record<string, string> = {};
  if (j.intents && typeof j.intents === "object" && !Array.isArray(j.intents)) {
    for (const [k, v] of Object.entries(j.intents as Record<string, unknown>)) {
      if (/^[a-z0-9_]{1,40}$/.test(k) && typeof v === "string" && v.trim())
        intents[k] = clipText(v.trim(), 200);
    }
  }
  const oc =
    j.outputCheck && typeof j.outputCheck === "object"
      ? (j.outputCheck as Record<string, unknown>)
      : {};
  const instructions =
    typeof oc.instructions === "string"
      ? clipText(oc.instructions.trim(), 1500)
      : "";
  return {
    enabled: true,
    ackThreshold: num(j.ackThreshold, 0.9),
    humanThreshold: num(j.humanThreshold, 0.9),
    intents: Object.keys(intents).length >= 2 ? intents : {},
    ackEmoji:
      typeof j.ackEmoji === "string" && j.ackEmoji.trim()
        ? j.ackEmoji.trim()
        : "👍",
    outputCheck: {
      enabled: oc.enabled === true && !!instructions,
      instructions,
      threshold: num(oc.threshold, 0.9),
      handoffMessage:
        typeof oc.handoffMessage === "string" && oc.handoffMessage.trim()
          ? clipText(oc.handoffMessage.trim(), 500)
          : "Deixa eu confirmar isso com a equipe e já te respondo aqui 🙏",
    },
  };
}

type Question =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

type Answer = {
  type?: string;
  noul?: number;
  score?: number;
  choice?: string;
  confidence?: number;
};

export interface JevDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

async function ask(
  state: string,
  questions: Record<string, Question>,
  deps: JevDeps,
): Promise<Record<string, Answer> | null> {
  const key = deps.apiKey ?? config.jev.apiKey;
  if (!key) return null;
  try {
    const res = await (deps.fetchImpl ?? fetch)(JEV_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: clipText(state, STATE_MAX_CHARS),
        questions,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("jev: answered %d", res.status);
      return null;
    }
    const body = (await res.json().catch(() => null)) as {
      answers?: Record<string, Answer>;
    } | null;
    return body?.answers && typeof body.answers === "object"
      ? body.answers
      : null;
  } catch (err) {
    logger.warn(
      "jev: call failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export interface JevReading {
  ack: number;
  human: number;
  frustration: number | null;
  frustrationConfidence: number;
  intent: string | null;
  intentConfidence: number;
}

const FRUSTRATION_LEVELS = [
  "Calmo, neutro ou animado",
  "Incomodado ou impaciente, mas educado",
  "Bravo: reclama forte, xinga ou ameaça",
];

// One call, every question at once (Jev answers them in parallel; output tokens are free).
export async function readCustomerMessage(
  cfg: JevConfig,
  text: string,
  deps: JevDeps = {},
): Promise<JevReading | null> {
  if (!text.trim()) return null;
  const questions: Record<string, Question> = {
    ack: {
      type: "noul",
      instructions:
        "A mensagem do cliente é só um agradecimento, confirmação ou despedida ('ok', 'valeu', 'obrigado', 'beleza', emoji ou figurinha), sem nenhum pedido, pergunta ou informação nova.",
    },
    human: {
      type: "noul",
      instructions:
        "Na mensagem o cliente pede para falar com uma pessoa, um atendente humano, o dono, o gerente ou a equipe.",
    },
    frustration: {
      type: "score",
      instructions: "Quão frustrado ou bravo o cliente está nesta mensagem",
      criteria: FRUSTRATION_LEVELS,
    },
  };
  if (Object.keys(cfg.intents).length) {
    questions.intent = {
      type: "choice",
      instructions: "O que o cliente quer nesta mensagem",
      criteria: cfg.intents,
    };
  }
  const a = await ask(`Mensagem do cliente:\n${text}`, questions, deps);
  if (!a) return null;
  const p = (x: Answer | undefined) =>
    typeof x?.noul === "number" ? x.noul : 0;
  return {
    ack: p(a.ack),
    human: p(a.human),
    frustration:
      typeof a.frustration?.score === "number" ? a.frustration.score : null,
    frustrationConfidence: a.frustration?.confidence ?? 0,
    intent: typeof a.intent?.choice === "string" ? a.intent.choice : null,
    intentConfidence: a.intent?.confidence ?? 0,
  };
}

// Whether the turn may end with a reaction and no model call: an acknowledgement, short, and nothing in
// it that asks for anything (the human question below the threshold).
export function isBareAcknowledgement(
  cfg: JevConfig,
  r: JevReading,
  text: string,
): boolean {
  return r.ack >= cfg.ackThreshold && r.human < 0.5 && text.trim().length <= 60;
}

// The reading the model gets with the customer's message, in the agent's language. Null when there is
// nothing worth saying (a calm message with no clear intent).
export function readingNote(cfg: JevConfig, r: JevReading): string | null {
  const lines: string[] = [];
  if (r.human >= cfg.humanThreshold) {
    lines.push(
      "- O cliente PEDIU UMA PESSOA: transfira agora, do jeito que suas regras mandam para uma transferência.",
    );
  }
  if (
    r.frustration !== null &&
    r.frustration >= 1.5 &&
    r.frustrationConfidence >= 0.6
  ) {
    lines.push(
      "- O cliente está BRAVO: acolha primeiro, assuma o que for da casa, sem vender e sem humor.",
    );
  } else if (
    r.frustration !== null &&
    r.frustration >= 0.5 &&
    r.frustrationConfidence >= 0.6
  ) {
    lines.push("- O cliente está impaciente: seja breve e resolva primeiro.");
  }
  if (r.intent && r.intentConfidence >= 0.7 && cfg.intents[r.intent]) {
    lines.push(`- Intenção provável: ${r.intent} (${cfg.intents[r.intent]}).`);
  }
  if (!lines.length) return null;
  return `<leitura_automatica>\nLeitura rápida desta mensagem (não mencione ao cliente):\n${lines.join("\n")}\n</leitura_automatica>`;
}

// The probability that the reply breaks the operator's rules, or null when the check did not run.
export async function replyBreaksRules(
  cfg: JevConfig,
  reply: string,
  deps: JevDeps = {},
): Promise<number | null> {
  if (!cfg.outputCheck.enabled || !reply.trim()) return null;
  const a = await ask(
    `Resposta que o atendente virtual vai enviar ao cliente:\n${reply}`,
    {
      breaks: {
        type: "noul",
        instructions: `A resposta faz alguma destas coisas proibidas: ${cfg.outputCheck.instructions}`,
      },
    },
    deps,
  );
  return typeof a?.breaks?.noul === "number" ? a.breaks.noul : null;
}
