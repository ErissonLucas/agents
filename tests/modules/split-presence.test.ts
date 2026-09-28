import { describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { holdPresence, PRESENCE_REFRESH_MS } from "@/modules/split/presence";

// The think-time indicator: shown once, re-sent on an interval, switched to recording for a voice
// reply, left to the delivery when it takes over, and turned off exactly once at the end.

function harness(opts: { failing?: boolean } = {}) {
  const sent: Array<boolean | "recording"> = [];
  const client = {
    toggleTyping: async (_id: number, on: boolean | "recording") => {
      sent.push(on);
      if (opts.failing) throw new Error("presence down");
      return {};
    },
  } as unknown as ChatwootClient;
  let tick: (() => void) | null = null;
  let intervalMs = 0;
  const deps = {
    setInterval: (fn: () => void, ms: number) => {
      tick = fn;
      intervalMs = ms;
      return fn;
    },
    clearInterval: (h: unknown) => {
      if (h === tick) tick = null;
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    sent,
    client,
    deps,
    flush,
    tick: () => tick?.(),
    armed: () => tick !== null,
    intervalMs: () => intervalMs,
  };
}

describe("holdPresence", () => {
  test("shows typing at once and re-sends it on every refresh", async () => {
    const h = harness();
    const hold = holdPresence(h.client, 9, "typing", h.deps);
    await h.flush();
    expect(h.sent).toEqual([true]);
    expect(h.intervalMs()).toBe(PRESENCE_REFRESH_MS);
    h.tick();
    await h.flush();
    h.tick();
    await h.flush();
    expect(h.sent).toEqual([true, true, true]);
    await hold.end();
    expect(h.sent).toEqual([true, true, true, false]);
    expect(h.armed()).toBe(false);
  });

  test("switches to recording and refreshes recording", async () => {
    const h = harness();
    const hold = holdPresence(h.client, 9, "typing", h.deps);
    hold.set("recording");
    await h.flush();
    h.tick();
    await h.flush();
    expect(h.sent).toEqual([true, "recording", "recording"]);
    hold.set("recording");
    await h.flush();
    expect(h.sent).toEqual([true, "recording", "recording"]);
    await hold.end();
    expect(h.sent.at(-1)).toBe(false);
  });

  test("quiet stops the refresh without turning the indicator off", async () => {
    const h = harness();
    const hold = holdPresence(h.client, 9, "typing", h.deps);
    hold.quiet();
    await h.flush();
    expect(h.armed()).toBe(false);
    expect(h.sent).toEqual([true]);
    await hold.end();
    expect(h.sent).toEqual([true, false]);
  });

  test("end is idempotent and nothing is sent after it", async () => {
    const h = harness();
    const hold = holdPresence(h.client, 9, "typing", h.deps);
    await hold.end();
    await hold.end();
    hold.set("recording");
    await h.flush();
    expect(h.sent).toEqual([true, false]);
  });

  test("a failing channel never throws out of the hold", async () => {
    const h = harness({ failing: true });
    const hold = holdPresence(h.client, 9, "typing", h.deps);
    h.tick();
    hold.set("recording");
    await expect(hold.end()).resolves.toBeUndefined();
    expect(h.sent).toEqual([true, true, "recording", false]);
  });

  test("a client without the method is survived", async () => {
    const hold = holdPresence({} as unknown as ChatwootClient, 9, "typing", {
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await expect(hold.end()).resolves.toBeUndefined();
  });

  test("the off is never overtaken by the on before it", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const client = {
      toggleTyping: async (_id: number, on: boolean | "recording") => {
        if (on === true) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        order.push(String(on));
        return {};
      },
    } as unknown as ChatwootClient;
    const hold = holdPresence(client, 9, "typing", {
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    const ended = hold.end();
    await new Promise((r) => setTimeout(r, 0));
    (release as (() => void) | null)?.();
    await ended;
    expect(order).toEqual(["true", "false"]);
  });
});
