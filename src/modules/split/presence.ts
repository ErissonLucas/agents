import type { ChatwootClient } from "@/modules/chatwoot/client";

// The indicator the contact watches while a reactive turn works: "typing…" while the model thinks,
// "recording audio…" while a voice reply is synthesized. WhatsApp drops a presence after a few
// seconds, so the hold re-sends it on an interval until the delivery takes over or the turn ends.
// Best-effort throughout: a presence that fails is never the turn's failure.

export type PresenceState = "typing" | "recording";

// Under RyzeAPI's own expiry (5–10s without a duration, 20s with the one the Ryze client sends).
export const PRESENCE_REFRESH_MS = 12_000;

export interface PresenceHold {
  // Shows `state` now (only when it changed) and keeps re-sending it.
  set(state: PresenceState): void;
  // Stops re-sending and leaves the last state to the delivery, which drives its own indicator.
  quiet(): void;
  // Stops re-sending and turns the indicator off. Idempotent; never rejects.
  end(): Promise<void>;
}

export interface PresenceDeps {
  refreshMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

type PresenceClient = Pick<ChatwootClient, "toggleTyping">;

async function send(
  client: PresenceClient,
  conversationId: number,
  value: boolean | "recording",
): Promise<void> {
  // NOTE: try/catch and not only `.catch()`: a client without the method throws while INVOKING.
  try {
    await client.toggleTyping(conversationId, value);
  } catch {
    // Best-effort by contract.
  }
}

export function holdPresence(
  client: PresenceClient,
  conversationId: number,
  initial: PresenceState,
  deps: PresenceDeps = {},
): PresenceHold {
  const every = deps.refreshMs ?? PRESENCE_REFRESH_MS;
  const arm =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const disarm =
    deps.clearInterval ??
    ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let state: PresenceState = initial;
  let timer: unknown = null;
  let ended = false;
  let busy = false;
  // NOTE: one request at a time, in order, so an "off" can never overtake the "on" before it.
  let chain: Promise<void> = Promise.resolve();
  const push = (v: boolean | "recording"): Promise<void> => {
    chain = chain.then(() => send(client, conversationId, v));
    return chain;
  };
  const value = (): boolean | "recording" =>
    state === "recording" ? "recording" : true;
  const stopTimer = (): void => {
    if (timer !== null) disarm(timer);
    timer = null;
  };
  const startTimer = (): void => {
    stopTimer();
    timer = arm(() => {
      // NOTE: a refresh still waiting on a slow channel is not stacked with another.
      if (busy) return;
      busy = true;
      void push(value()).finally(() => {
        busy = false;
      });
    }, every);
  };
  void push(value());
  startTimer();
  return {
    set(next) {
      if (ended) return;
      const changed = next !== state;
      state = next;
      if (changed || timer === null) {
        void push(value());
        startTimer();
      }
    },
    quiet() {
      stopTimer();
    },
    async end() {
      if (ended) return;
      ended = true;
      stopTimer();
      await push(false);
    },
  };
}
