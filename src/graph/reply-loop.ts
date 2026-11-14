import config from "@/config";

// HOW MANY REPLIES ONE CONVERSATION GOT LATELY, to tell a customer from a bot answering our bot.
// Two automated numbers that each reply to every message never stop, and every round costs a model
// call and a message on the customer's number. Past `replyLoopMax` replies inside the window, replies
// to that conversation are held for `replyLoopPauseMs`; holding ours is what stops the other side.
//
// In memory and per process: the deploy runs one replica, and a restart forgetting the count only
// gives a loop one more window before it trips again.
const KEY = Symbol.for("fazerai.reply-loop");

interface LoopState {
  sent: Map<string, number[]>;
  pausedUntil: Map<string, number>;
}

function state(): LoopState {
  const g = globalThis as unknown as Record<symbol, LoopState>;
  g[KEY] ??= { sent: new Map(), pausedUntil: new Map() };
  return g[KEY];
}

export interface ReplyLoopLimits {
  max: number;
  windowMs: number;
  pauseMs: number;
}

function limits(): ReplyLoopLimits {
  return {
    max: config.agent.replyLoopMax,
    windowMs: config.agent.replyLoopWindowMs,
    pauseMs: config.agent.replyLoopPauseMs,
  };
}

export type ReplyLoopVerdict =
  | { held: false }
  | { held: true; tripped: boolean; replies: number };

export function checkReplyLoop(
  threadId: string,
  now = Date.now(),
  lim: ReplyLoopLimits = limits(),
): ReplyLoopVerdict {
  const s = state();
  const until = s.pausedUntil.get(threadId);
  if (until !== undefined) {
    if (now < until) return { held: true, tripped: false, replies: 0 };
    s.pausedUntil.delete(threadId);
    s.sent.delete(threadId);
  }
  const recent = (s.sent.get(threadId) ?? []).filter(
    (t) => now - t < lim.windowMs,
  );
  s.sent.set(threadId, recent);
  if (recent.length < lim.max) return { held: false };
  s.pausedUntil.set(threadId, now + lim.pauseMs);
  return { held: true, tripped: true, replies: recent.length };
}

export function recordReply(threadId: string, now = Date.now()): void {
  const s = state();
  const list = s.sent.get(threadId) ?? [];
  list.push(now);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  s.sent.set(threadId, list);
  if (s.sent.size > 50_000) {
    const oldest = s.sent.keys().next().value;
    if (oldest !== undefined) s.sent.delete(oldest);
  }
}

export function resetReplyLoopForTests(): void {
  const s = state();
  s.sent.clear();
  s.pausedUntil.clear();
}
