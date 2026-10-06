import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  describeReplyGateHeld,
  type ReplyGateSeam,
} from "@/modules/chatwoot/gate-close";
import { withConversationLabels } from "@/modules/chatwoot/labels";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { sameLabelTitle } from "@/modules/ryze/label-shared";

// THE REPLY GATE (Livare F2.1, docs/LIVARE-F21-PORTAO-ETIQUETA.md): with it on, the agent speaks in a
// conversation only while the conversation carries the operator's label. Off by default, and an
// agent whose bag has no `replyGate` block behaves exactly as before: nothing here is read for it.
//
// It closes on doubt. A label that is absent, a label the number's WhatsApp catalog does not know or
// has not synced yet, the hand-off label, a `human_takeover` label and a read that failed all keep
// the agent quiet. It only ever holds SPEECH: the mirror, the memory and the ingestion of what the
// customer says carry on, so the agent knows the conversation when the label comes back.

export interface ReplyGateConfig {
  enabled: boolean;
  // The label the conversation must carry for the agent to speak.
  requiredLabel: string | null;
  // The label a hand-off puts on (on a RyzeAPI number, only when the number's catalog has it).
  handoffLabel: string | null;
  // Whether a hand-off takes `requiredLabel` off. Default true.
  removeOnHandoff: boolean;
}

export const REPLY_GATE_DEFAULTS: ReplyGateConfig = {
  enabled: false,
  requiredLabel: null,
  handoffLabel: null,
  removeOnHandoff: true,
};

function labelOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

export function readReplyGateConfig(settings: unknown): ReplyGateConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).replyGate
      : undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { ...REPLY_GATE_DEFAULTS };
  }
  const bag = s as Record<string, unknown>;
  return {
    // Only an explicit `true` turns it on: the default is the behaviour every agent already has.
    enabled: bag.enabled === true,
    requiredLabel: labelOf(bag.requiredLabel),
    handoffLabel: labelOf(bag.handoffLabel),
    removeOnHandoff: bag.removeOnHandoff !== false,
  };
}

// The labels the gate owns, which `set_labels` must neither add nor remove: a model that could add
// the required label would open its own gate, and one that removed it would close it mid-sentence.
export function replyGateControlLabels(cfg: ReplyGateConfig): string[] {
  if (!cfg.enabled) return [];
  return [cfg.requiredLabel, cfg.handoffLabel].filter(
    (l): l is string => l !== null,
  );
}

export const REPLY_GATE_CLOSED_REASONS = [
  // On, with no label to require: misconfigured, and closed rather than open.
  "no_required_label",
  "label_missing",
  // RyzeAPI: the title is not in the number's live catalog.
  "label_unknown",
  // RyzeAPI: the catalog row has no WhatsApp id yet, or the number refuses label calls.
  "label_unsynced",
  "handed_off",
  // RyzeAPI: a label whose rule is `human_takeover` is on the conversation.
  "human_takeover",
  "unreadable",
] as const;
export type ReplyGateClosedReason = (typeof REPLY_GATE_CLOSED_REASONS)[number];

export type ReplyGateVerdict =
  | { open: true }
  | { open: false; reason: ReplyGateClosedReason };

const OPEN: ReplyGateVerdict = { open: true };
const closed = (reason: ReplyGateClosedReason): ReplyGateVerdict => ({
  open: false,
  reason,
});

export interface ReplyGateCatalogEntry {
  title: string;
  tagId: string | null;
  autoRule: string | null;
}

// What the gate reads about one conversation. `ryze` is present only on a RyzeAPI number, whose
// labels are WhatsApp Business labels with a catalog of their own.
export interface ReplyGateSnapshot {
  labels: readonly string[];
  ryze: {
    catalog: readonly ReplyGateCatalogEntry[];
    labelsSupported: boolean | null;
  } | null;
}

export function judgeReplyGate(
  cfg: ReplyGateConfig,
  snap: ReplyGateSnapshot,
): ReplyGateVerdict {
  if (!cfg.enabled) return OPEN;
  const required = cfg.requiredLabel;
  if (!required) return closed("no_required_label");
  const has = (title: string) =>
    snap.labels.some((l) => sameLabelTitle(l, title));
  if (cfg.handoffLabel && has(cfg.handoffLabel)) return closed("handed_off");
  if (snap.ryze) {
    const takeover = snap.ryze.catalog.some(
      (row) => row.autoRule === "human_takeover" && has(row.title),
    );
    if (takeover) return closed("human_takeover");
  }
  if (!has(required)) return closed("label_missing");
  if (snap.ryze) {
    const row = snap.ryze.catalog.find((r) =>
      sameLabelTitle(r.title, required),
    );
    if (!row) return closed("label_unknown");
    if (!row.tagId || snap.ryze.labelsSupported === false) {
      return closed("label_unsynced");
    }
  }
  return OPEN;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The conversation's labels as the gate reads them, or null when they cannot be read. On a RyzeAPI
// number they come from our own tables (the emulated Chatwoot is in-process); elsewhere from
// Chatwoot, through `readLabels`, and a caller that has no way to ask gets null.
export async function readReplyGateSnapshot(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  base?: PrismaClient;
  readLabels?: () => Promise<unknown>;
}): Promise<ReplyGateSnapshot | null> {
  const base = p.base ?? basePrisma;
  try {
    const ryze = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
      const gw = await db.ryzeGateway.findUnique({
        where: { chatwootInstanceId: p.instanceId },
        select: { id: true, labelsSupported: true },
      });
      if (!gw) return null;
      const conv = await db.ryzeConversation.findUnique({
        where: { displayId: p.conversationId },
        select: { gatewayId: true, labels: true },
      });
      const catalog = await db.ryzeLabel.findMany({
        where: { gatewayId: gw.id, deletedAt: null },
        select: { title: true, tagId: true, autoRule: true },
      });
      return {
        conv: conv && conv.gatewayId === gw.id ? conv : null,
        catalog,
        labelsSupported: gw.labelsSupported,
      };
    });
    if (ryze) {
      if (!ryze.conv) return null;
      return {
        labels: [...ryze.conv.labels],
        ryze: { catalog: ryze.catalog, labelsSupported: ryze.labelsSupported },
      };
    }
    if (!p.readLabels) return null;
    const raw = await p.readLabels();
    if (!Array.isArray(raw)) return null;
    return {
      labels: raw.filter((l): l is string => typeof l === "string"),
      ryze: null,
    };
  } catch (err) {
    logger.warn(
      { err, conv: p.conversationId },
      "reply gate: the conversation's labels could not be read; holding the reply",
    );
    return null;
  }
}

// The agent's gate as stored NOW. A config loaded at the start of a turn is a model call old by the
// first send, and an operator who turns the gate off must not have to wait for the next turn.
// Unreadable: the fallback the caller loaded, and with none, the gate is not known to exist, which
// is the state every agent was in before it did.
async function currentConfig(p: {
  tenantId: bigint;
  agentId: bigint | null;
  base: PrismaClient;
  fallback?: ReplyGateConfig;
}): Promise<ReplyGateConfig | null> {
  if (p.agentId === null) return p.fallback ?? null;
  const agentId = p.agentId;
  try {
    const agent = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { settings: true },
      }),
    );
    return readReplyGateConfig(agent?.settings);
  } catch (err) {
    logger.warn(
      { err, agentId: String(agentId) },
      "reply gate: could not re-read the agent's gate; using the one this run loaded",
    );
    return p.fallback ?? null;
  }
}

// The question every speaking seam asks, at the send. `config` skips the agent read for a caller
// that just read the row; `fallback` is what a caller loaded earlier, used only if the read fails.
export async function replyGateVerdictNow(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint | null;
  base?: PrismaClient;
  readLabels?: () => Promise<unknown>;
  config?: ReplyGateConfig;
  fallback?: ReplyGateConfig;
}): Promise<ReplyGateVerdict> {
  const base = p.base ?? basePrisma;
  const cfg =
    p.config ??
    (await currentConfig({
      tenantId: p.tenantId,
      agentId: p.agentId,
      base,
      fallback: p.fallback,
    }));
  if (!cfg?.enabled) return OPEN;
  if (!cfg.requiredLabel) return closed("no_required_label");
  const snap = await readReplyGateSnapshot({
    tenantId: p.tenantId,
    instanceId: p.instanceId,
    conversationId: p.conversationId,
    base,
    readLabels: p.readLabels,
  });
  if (!snap) return closed("unreadable");
  return judgeReplyGate(cfg, snap);
}

// The record that the gate held something back: a process log line and a `handoff` flow line, both
// with the seam and the reason and nothing the customer or the agent wrote.
export function reportReplyGateHeld(p: {
  seam: ReplyGateSeam;
  reason: ReplyGateClosedReason;
  tenantId: bigint;
  conversationId: number;
  flow?: FlowContext | null;
  conversationRowId?: bigint | null;
  agentId?: bigint | null;
  inboxRowId?: bigint | null;
  base?: PrismaClient;
}): void {
  logger.info(
    {
      conv: p.conversationId,
      seam: p.seam,
      reason: p.reason,
      agentId: p.agentId == null ? undefined : String(p.agentId),
    },
    "reply gate: held a reply (conv=%s seam=%s reason=%s)",
    String(p.conversationId),
    p.seam,
    p.reason,
  );
  const flow: FlowContext = p.flow ?? {
    tenantId: p.tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: p.conversationRowId ?? null,
    agentId: p.agentId ?? null,
    inboxId: p.inboxRowId ?? null,
    base: p.base,
  };
  emitFlowEvent(flow, {
    stage: "handoff",
    level: "info",
    status: "skipped",
    detail: describeReplyGateHeld(p.reason, p.seam),
  });
}

// The conversation's labels after a hand-off: the required one off (when configured), the hand-off
// one on. `known` narrows what may be ADDED (a RyzeAPI catalog); removal is never narrowed.
export function replyGateLabelsAfterHandoff(
  cfg: ReplyGateConfig,
  current: readonly string[],
  known?: (title: string) => boolean,
): string[] {
  let next = [...current];
  if (cfg.removeOnHandoff && cfg.requiredLabel) {
    const required = cfg.requiredLabel;
    next = next.filter((l) => !sameLabelTitle(l, required));
  }
  const handoff = cfg.handoffLabel;
  if (
    handoff &&
    !next.some((l) => sameLabelTitle(l, handoff)) &&
    (!known || known(handoff))
  ) {
    next.push(handoff);
  }
  return next;
}

// The conversation's labels once an operator hands it to the agent (`/teste`, `/reset` on a test
// agent): the hand-off label off, the required one on.
export function replyGateLabelsAfterGrant(
  cfg: ReplyGateConfig,
  current: readonly string[],
  known?: (title: string) => boolean,
): string[] {
  const handoff = cfg.handoffLabel;
  const next = handoff
    ? current.filter((l) => !sameLabelTitle(l, handoff))
    : [...current];
  const required = cfg.requiredLabel;
  if (
    required &&
    !next.some((l) => sameLabelTitle(l, required)) &&
    (!known || known(required))
  ) {
    next.push(required);
  }
  return next;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l) => b.includes(l));
}

// The grant `/teste` and `/reset` make with the gate on, through the client and inside the
// conversation's label queue like every other label writer. Idempotent, and it never throws: a
// label the WhatsApp side refuses leaves the gate closed, which is the safe side.
export async function grantReplyGateLabel(p: {
  client: ChatwootClient;
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  cfg: ReplyGateConfig;
  base?: PrismaClient;
}): Promise<"changed" | "unchanged" | "failed"> {
  if (!p.cfg.enabled || !p.cfg.requiredLabel) return "unchanged";
  try {
    return await withConversationLabels(
      p.tenantId,
      p.conversationId,
      async () => {
        const snap = await readReplyGateSnapshot({
          tenantId: p.tenantId,
          instanceId: p.instanceId,
          conversationId: p.conversationId,
          base: p.base,
          readLabels: () => p.client.getConversationLabels(p.conversationId),
        });
        if (!snap) return "failed" as const;
        const catalog = snap.ryze?.catalog;
        const known = catalog
          ? (title: string) =>
              catalog.some((r) => sameLabelTitle(r.title, title))
          : undefined;
        const next = replyGateLabelsAfterGrant(p.cfg, snap.labels, known);
        if (sameSet(next, snap.labels)) return "unchanged" as const;
        await p.client.setConversationLabels(p.conversationId, next, {
          asAdmin: true,
        });
        return "changed" as const;
      },
    );
  } catch (err) {
    logger.warn(
      { err, conv: p.conversationId },
      "reply gate: could not put the required label on the conversation",
    );
    return "failed";
  }
}
