import { randomUUID } from "node:crypto";

// Thread keys of the turns that run outside a Chatwoot conversation: tenantId:<kind>:agentId:uuid.
// The tenantId prefix is the checkpointer's tenant fence; the kind and agentId segments keep each
// channel apart from real conversations, from the other channel and from other agents. A
// client-supplied id is honored ONLY in this exact shape, so nobody can pass a conversation's
// thread (or another channel's) and read its history.
export type DetachedThreadKind = "playground" | "client";

// What a thread being expired is claimed with, for good (`leaseClientThread` only takes a claim that
// ran out): such a thread is on its way out, so nothing else waits on it.
export const EXPIRY_CLAIM = "expire";

// Whether a client-channel user id is an anonymous session's: only the anonymous session module
// mints the `anon:` prefix, and the routes that take an id from a host refuse it.
export function isAnonUserId(id: string): boolean {
  return id.startsWith("anon:");
}

export function newDetachedThreadId(
  kind: DetachedThreadKind,
  tenantId: bigint,
  agentId: bigint,
): string {
  return `${tenantId}:${kind}:${agentId}:${randomUUID()}`;
}

export function isValidDetachedThread(
  kind: DetachedThreadKind,
  threadId: string,
  tenantId: bigint,
  agentId: bigint,
): boolean {
  const parts = threadId.split(":");
  return (
    parts.length === 4 &&
    parts[0] === String(tenantId) &&
    parts[1] === kind &&
    parts[2] === String(agentId)
  );
}

// The caller's thread when it is this channel's, this tenant's and this agent's; a fresh one
// otherwise.
export function resolveDetachedThread(
  kind: DetachedThreadKind,
  threadId: string | undefined,
  tenantId: bigint,
  agentId: bigint,
): string {
  return threadId && isValidDetachedThread(kind, threadId, tenantId, agentId)
    ? threadId
    : newDetachedThreadId(kind, tenantId, agentId);
}
