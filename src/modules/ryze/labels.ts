import type {
  PrismaClient,
  RyzeConversation,
  RyzeGateway,
  RyzeLabel,
} from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { RyzeApiError, type RyzeClient, type RyzeTag } from "./client";
import { emitToBots } from "./emit";
import { ryzeClientForGateway } from "./gateway-client";
import {
  chatNumber,
  isRyzeLabelAutoRule,
  isRyzeLabelColor,
  labelDelta,
  labelSlug,
  RYZE_LABEL_DESCRIPTION_MAX,
  RYZE_LABEL_MAX,
  RYZE_LABEL_TITLE_MAX,
  type RyzeLabelAutoRule,
  sameLabelTitle,
} from "./label-shared";
import { brazilianNinthDigitVariant, conversationBody, scoped } from "./store";

// WhatsApp Business labels of a RyzeAPI number. The catalog (`ryze_labels`) is ours and always
// written; WhatsApp is kept in step best-effort: a number that refuses label calls (a regular
// WhatsApp account) is flagged `labelsSupported = false` and asked again at most every 6 hours, and
// no label write ever fails a turn because of WhatsApp. Syncs of one gateway run in order, detached
// from the write that caused them (`drainLabelSyncs` waits for them).

export interface RyzeLabelDeps {
  base?: PrismaClient;
  makeRyzeClient?: (gw: RyzeGateway) => Promise<RyzeClient>;
}

export interface RyzeLabelView {
  id: string;
  title: string;
  displayName: string;
  color: number;
  description: string | null;
  autoRule: RyzeLabelAutoRule | null;
  tagId: string | null;
  origin: "fazerai" | "device";
  createdAt: string;
}

export interface RyzeLabelCatalog {
  labelsSupported: boolean | null;
  max: number;
  labels: RyzeLabelView[];
}

const RECHECK_MS = 6 * 60 * 60 * 1000;

function describe(err: unknown): string {
  if (err instanceof RyzeApiError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * A refusal of label calls as such (the number is not WhatsApp Business), as opposed to a label
 * that is missing (404) or a gateway that is down (5xx, network).
 */
export function isLabelRefusal(err: unknown, listing = false): boolean {
  if (!(err instanceof RyzeApiError)) return false;
  if (err.status === 404) return listing;
  return (
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

/** Whether label calls are worth trying now: not known to be refused, or refused long enough ago. */
export function labelsWorthTrying(
  gw: Pick<RyzeGateway, "labelsSupported" | "labelsCheckedAt">,
  now: Date = new Date(),
): boolean {
  if (gw.labelsSupported !== false) return true;
  if (!gw.labelsCheckedAt) return true;
  return now.getTime() - gw.labelsCheckedAt.getTime() >= RECHECK_MS;
}

function viewOf(row: RyzeLabel): RyzeLabelView {
  return {
    id: String(row.id),
    title: row.title,
    displayName: row.displayName ?? row.title,
    color: row.color,
    description: row.description,
    autoRule: isRyzeLabelAutoRule(row.autoRule) ? row.autoRule : null,
    tagId: row.tagId,
    origin: row.origin === "device" ? "device" : "fazerai",
    createdAt: row.createdAt.toISOString(),
  };
}

function liveRows(db: ScopedDb, gatewayId: bigint): Promise<RyzeLabel[]> {
  return db.ryzeLabel.findMany({
    where: { gatewayId, deletedAt: null },
    orderBy: { id: "asc" },
  });
}

function findByTitle(
  rows: readonly RyzeLabel[],
  title: string,
): RyzeLabel | undefined {
  return rows.find((r) => sameLabelTitle(r.title, title));
}

// A free title for an imported name: its slug, suffixed when a live row already holds it.
function freeTitle(rows: readonly RyzeLabel[], name: string): string {
  const base = labelSlug(name) || "etiqueta";
  if (!findByTitle(rows, base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base.slice(0, RYZE_LABEL_TITLE_MAX - 4)}-${n}`;
    if (!findByTitle(rows, next)) return next;
  }
}

async function markSupport(
  gw: RyzeGateway,
  supported: boolean,
  base: PrismaClient,
): Promise<void> {
  gw.labelsSupported = supported;
  gw.labelsCheckedAt = new Date();
  await scoped(
    gw.tenantId,
    (db) =>
      db.ryzeGateway.update({
        where: { id: gw.id },
        data: { labelsSupported: supported, labelsCheckedAt: new Date() },
      }),
    base,
  );
}

// Removes a title from every conversation of the gateway (a label that no longer exists).
async function dropTitleFromConversations(
  db: ScopedDb,
  gatewayId: bigint,
  title: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE ryze_conversations SET labels = array_remove(labels, ${title})
     WHERE gateway_id = ${gatewayId} AND ${title} = ANY(labels)`;
}

// Merges WhatsApp's own list into the catalog: a tag we hold by id is refreshed, one whose name
// matches a row without an id lends it its id, anything else was created on the phone.
async function mergeTags(
  gw: RyzeGateway,
  tags: readonly RyzeTag[],
  base: PrismaClient,
): Promise<void> {
  await scoped(
    gw.tenantId,
    async (db) => {
      const rows = await liveRows(db, gw.id);
      for (const tag of tags) {
        const byId = rows.find((r) => r.tagId === tag.id);
        if (tag.deleted) {
          if (byId) {
            await db.ryzeLabel.update({
              where: { id: byId.id },
              data: { deletedAt: new Date() },
            });
            await dropTitleFromConversations(db, gw.id, byId.title);
            rows.splice(rows.indexOf(byId), 1);
          }
          continue;
        }
        if (byId) {
          if (
            (byId.displayName ?? byId.title) !== tag.name ||
            byId.color !== tag.color
          ) {
            await db.ryzeLabel.update({
              where: { id: byId.id },
              data: {
                displayName: tag.name,
                ...(isRyzeLabelColor(tag.color) ? { color: tag.color } : {}),
              },
            });
          }
          continue;
        }
        const byName = rows.find(
          (r) =>
            r.tagId === null &&
            (sameLabelTitle(r.displayName ?? r.title, tag.name) ||
              sameLabelTitle(r.title, tag.name) ||
              r.title === labelSlug(tag.name)),
        );
        if (byName) {
          const updated = await db.ryzeLabel.update({
            where: { id: byName.id },
            data: { tagId: tag.id },
          });
          rows.splice(rows.indexOf(byName), 1, updated);
          continue;
        }
        const created = await db.ryzeLabel.create({
          data: {
            tenantId: gw.tenantId,
            gatewayId: gw.id,
            title: freeTitle(rows, tag.name),
            displayName: tag.name,
            color: isRyzeLabelColor(tag.color) ? tag.color : 0,
            tagId: tag.id,
            origin: "device",
          },
        });
        rows.push(created);
      }
    },
    base,
  );
}

/** Pulls WhatsApp's label list into the catalog, when the number is worth asking. Never throws. */
export async function syncCatalogFromWhatsApp(
  gw: RyzeGateway,
  deps: RyzeLabelDeps = {},
): Promise<void> {
  const base = deps.base ?? basePrisma;
  if (!labelsWorthTrying(gw)) return;
  const make = deps.makeRyzeClient ?? ryzeClientForGateway;
  try {
    const ryze = await make(gw);
    const tags = await ryze.listTags();
    await markSupport(gw, true, base);
    await mergeTags(gw, tags, base);
  } catch (err) {
    if (isLabelRefusal(err, true)) {
      await markSupport(gw, false, base).catch(() => {});
    }
    logger.warn(
      "ryze: could not read the labels of %s: %s",
      gw.instanceName,
      describe(err),
    );
  }
}

async function gatewayOrThrow(
  ctx: TenantContext,
  instanceId: bigint,
  base: PrismaClient,
): Promise<RyzeGateway> {
  const gw = await runScopedOn(base, ctx, (db) =>
    db.ryzeGateway.findUnique({ where: { chatwootInstanceId: instanceId } }),
  );
  if (!gw) {
    throw new NotFoundError(
      "ryze gateway not found",
      "errors.ryzeGatewayNotFound",
    );
  }
  return gw;
}

async function catalogOf(
  ctx: TenantContext,
  gw: RyzeGateway,
  base: PrismaClient,
): Promise<RyzeLabelCatalog> {
  const rows = await runScopedOn(base, ctx, (db) => liveRows(db, gw.id));
  return {
    labelsSupported: gw.labelsSupported,
    max: RYZE_LABEL_MAX,
    labels: rows.map(viewOf),
  };
}

export async function listRyzeLabels(
  ctx: TenantContext,
  instanceId: bigint,
  deps: RyzeLabelDeps = {},
): Promise<RyzeLabelCatalog> {
  const base = deps.base ?? basePrisma;
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  await syncCatalogFromWhatsApp(gw, deps);
  return catalogOf(ctx, gw, base);
}

function cleanDescription(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const d = v.trim();
  if (d.length > RYZE_LABEL_DESCRIPTION_MAX) {
    throw new AppError(
      `description is longer than ${RYZE_LABEL_DESCRIPTION_MAX} characters`,
      400,
      "errors.ryzeLabelDescriptionTooLong",
      { max: RYZE_LABEL_DESCRIPTION_MAX },
      "description",
    );
  }
  return d.length > 0 ? d : null;
}

function cleanColor(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!isRyzeLabelColor(v)) {
    throw new AppError(
      "color must be an integer from 0 to 10",
      400,
      "errors.ryzeLabelColorInvalid",
      undefined,
      "color",
    );
  }
  return v;
}

function cleanAutoRule(
  v: string | null | undefined,
): RyzeLabelAutoRule | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isRyzeLabelAutoRule(v)) {
    throw new AppError(
      "unknown automatic rule",
      400,
      "errors.ryzeLabelRuleInvalid",
      undefined,
      "autoRule",
    );
  }
  return v;
}

function cleanName(v: string, field: string): string {
  const s = v.trim();
  if (s.length < 1 || s.length > RYZE_LABEL_TITLE_MAX) {
    throw new AppError(
      `${field} must have 1 to ${RYZE_LABEL_TITLE_MAX} characters`,
      400,
      "errors.ryzeLabelNameInvalid",
      { max: RYZE_LABEL_TITLE_MAX },
      field,
    );
  }
  return s;
}

export interface RyzeLabelInput {
  displayName: string;
  title?: string;
  color?: number;
  description?: string | null;
  autoRule?: string | null;
}

/**
 * Creates a label: on WhatsApp when the number takes it, in the catalog always. Refuses the 21st
 * live label (WhatsApp Business's limit) and a title or name already in use.
 */
export async function createRyzeLabel(
  ctx: TenantContext,
  instanceId: bigint,
  input: RyzeLabelInput,
  deps: RyzeLabelDeps = {},
): Promise<RyzeLabelView> {
  const base = deps.base ?? basePrisma;
  const displayName = cleanName(input.displayName, "displayName");
  const title = cleanName(
    input.title?.trim() ? input.title : labelSlug(displayName) || displayName,
    "title",
  );
  const color = cleanColor(input.color) ?? 0;
  const description = cleanDescription(input.description);
  const autoRule = cleanAutoRule(input.autoRule) ?? null;
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  await syncCatalogFromWhatsApp(gw, deps);
  const rows = await runScopedOn(base, ctx, (db) => liveRows(db, gw.id));
  if (rows.length >= RYZE_LABEL_MAX) {
    throw new AppError(
      `a WhatsApp Business number holds at most ${RYZE_LABEL_MAX} labels`,
      422,
      "errors.ryzeLabelLimit",
      { max: RYZE_LABEL_MAX },
    );
  }
  if (
    rows.some(
      (r) =>
        sameLabelTitle(r.title, title) ||
        sameLabelTitle(r.displayName ?? r.title, displayName),
    )
  ) {
    throw new ConflictError(
      "a label with this name already exists",
      "errors.ryzeLabelExists",
      "title",
    );
  }
  // NOTE: the row goes in before the WhatsApp call, so the `label.update` echo of our own create
  // finds it by name and lends it the id instead of importing it as a label made on the phone.
  let row = await runScopedOn(base, ctx, (db) =>
    db.ryzeLabel.create({
      data: {
        tenantId: gw.tenantId,
        gatewayId: gw.id,
        title,
        displayName: displayName === title ? null : displayName,
        color,
        description,
        autoRule,
        origin: "fazerai",
      },
    }),
  );
  if (labelsWorthTrying(gw)) {
    const make = deps.makeRyzeClient ?? ryzeClientForGateway;
    try {
      const tag = await (await make(gw)).createTag(displayName, color);
      const id = row.id;
      row = await runScopedOn(base, ctx, (db) =>
        db.ryzeLabel.update({ where: { id }, data: { tagId: tag.id } }),
      );
      if (gw.labelsSupported !== true) await markSupport(gw, true, base);
    } catch (err) {
      if (isLabelRefusal(err)) await markSupport(gw, false, base);
      logger.warn(
        "ryze: label %s not created on WhatsApp for %s: %s",
        title,
        gw.instanceName,
        describe(err),
      );
    }
  }
  return viewOf(row);
}

async function labelOrThrow(
  db: ScopedDb,
  gatewayId: bigint,
  labelId: bigint,
): Promise<RyzeLabel> {
  const row = await db.ryzeLabel.findUnique({ where: { id: labelId } });
  if (!row || row.gatewayId !== gatewayId || row.deletedAt) {
    throw new NotFoundError("label not found", "errors.ryzeLabelNotFound");
  }
  return row;
}

/**
 * Edits what only we hold: when to use it, its automatic rule and its color. RyzeAPI has no edit
 * endpoint, so a new color shows in the console only, not on the phone.
 */
export async function updateRyzeLabel(
  ctx: TenantContext,
  instanceId: bigint,
  labelId: bigint,
  input: {
    description?: string | null;
    color?: number;
    autoRule?: string | null;
  },
  deps: RyzeLabelDeps = {},
): Promise<RyzeLabelView> {
  const base = deps.base ?? basePrisma;
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  const color = cleanColor(input.color);
  const autoRule = cleanAutoRule(input.autoRule);
  const data = {
    ...(input.description !== undefined
      ? { description: cleanDescription(input.description) }
      : {}),
    ...(color !== undefined ? { color } : {}),
    ...(autoRule !== undefined ? { autoRule } : {}),
  };
  const row = await runScopedOn(base, ctx, async (db) => {
    const found = await labelOrThrow(db, gw.id, labelId);
    return db.ryzeLabel.update({ where: { id: found.id }, data });
  });
  return viewOf(row);
}

/**
 * Deletes a label on WhatsApp (a missing one is fine) and from the catalog, and takes it off every
 * conversation of the number. The row stays, soft-deleted.
 */
export async function deleteRyzeLabel(
  ctx: TenantContext,
  instanceId: bigint,
  labelId: bigint,
  deps: RyzeLabelDeps = {},
): Promise<void> {
  const base = deps.base ?? basePrisma;
  const gw = await gatewayOrThrow(ctx, instanceId, base);
  const row = await runScopedOn(base, ctx, (db) =>
    labelOrThrow(db, gw.id, labelId),
  );
  if (row.tagId && labelsWorthTrying(gw)) {
    const make = deps.makeRyzeClient ?? ryzeClientForGateway;
    try {
      await (await make(gw)).deleteTag(row.tagId);
    } catch (err) {
      if (!(err instanceof RyzeApiError && err.status === 404)) {
        if (isLabelRefusal(err)) await markSupport(gw, false, base);
        logger.warn(
          "ryze: label %s not deleted on WhatsApp for %s: %s",
          row.title,
          gw.instanceName,
          describe(err),
        );
      }
    }
  }
  await runScopedOn(base, ctx, async (db) => {
    await db.ryzeLabel.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
    await dropTitleFromConversations(db, gw.id, row.title);
  });
}

// The catalog row for a title the conversation just gained, created (origin fazerai, color 0) when
// there is none and room for it, with a WhatsApp id (created there when missing).
async function ensureTagged(
  gw: RyzeGateway,
  title: string,
  ryze: RyzeClient,
  base: PrismaClient,
): Promise<RyzeLabel | null> {
  const found = await scoped(
    gw.tenantId,
    async (db) => {
      const rows = await liveRows(db, gw.id);
      const hit = findByTitle(rows, title);
      if (hit) return hit;
      if (rows.length >= RYZE_LABEL_MAX || title.length > RYZE_LABEL_TITLE_MAX)
        return null;
      return db.ryzeLabel.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          title,
          origin: "fazerai",
        },
      });
    },
    base,
  );
  if (!found || found.tagId) return found;
  const tag = await ryze.createTag(
    found.displayName ?? found.title,
    found.color,
  );
  return scoped(
    gw.tenantId,
    (db) =>
      db.ryzeLabel.update({ where: { id: found.id }, data: { tagId: tag.id } }),
    base,
  );
}

async function forgetTagId(
  gw: RyzeGateway,
  row: RyzeLabel,
  base: PrismaClient,
): Promise<RyzeLabel> {
  return scoped(
    gw.tenantId,
    (db) =>
      db.ryzeLabel.update({ where: { id: row.id }, data: { tagId: null } }),
    base,
  );
}

async function syncNow(
  gw: RyzeGateway,
  chatJid: string,
  before: readonly string[],
  after: readonly string[],
  deps: RyzeLabelDeps,
): Promise<void> {
  const base = deps.base ?? basePrisma;
  const { added, removed } = labelDelta(before, after);
  if (added.length === 0 && removed.length === 0) return;
  const number = chatNumber(chatJid);
  if (!number) return;
  const fresh = await scoped(
    gw.tenantId,
    (db) => db.ryzeGateway.findUnique({ where: { id: gw.id } }),
    base,
  );
  if (!fresh || !labelsWorthTrying(fresh)) return;
  const make = deps.makeRyzeClient ?? ryzeClientForGateway;
  try {
    const ryze = await make(fresh);
    for (const title of added) {
      let row = await ensureTagged(fresh, title, ryze, base);
      if (!row?.tagId) continue;
      try {
        await ryze.assignTag(number, row.tagId);
      } catch (err) {
        if (!(err instanceof RyzeApiError && err.status === 404)) throw err;
        // NOTE: the tag is gone from WhatsApp (deleted on the phone while we missed the event):
        // recreate it once under the same name and assign that one.
        const cleared = await forgetTagId(fresh, row, base);
        row = await ensureTagged(fresh, cleared.title, ryze, base);
        if (row?.tagId) await ryze.assignTag(number, row.tagId);
      }
    }
    if (removed.length > 0) {
      const rows = await scoped(
        fresh.tenantId,
        (db) => liveRows(db, fresh.id),
        base,
      );
      for (const title of removed) {
        const row = findByTitle(rows, title);
        if (!row?.tagId) continue;
        try {
          await ryze.unassignTag(number, row.tagId);
        } catch (err) {
          if (!(err instanceof RyzeApiError && err.status === 404)) throw err;
        }
      }
    }
    if (fresh.labelsSupported !== true) await markSupport(fresh, true, base);
  } catch (err) {
    if (isLabelRefusal(err))
      await markSupport(fresh, false, base).catch(() => {});
    logger.warn(
      "ryze: labels of a conversation not synced to WhatsApp for %s: %s",
      fresh.instanceName,
      describe(err),
    );
  }
}

/**
 * Queues the WhatsApp side of a conversation's label change (added titles assigned, removed ones
 * unassigned) and returns at once. Never throws; skipped while the number is known to refuse labels.
 */
export function syncConversationLabels(
  gw: RyzeGateway,
  conv: Pick<RyzeConversation, "chatJid">,
  before: readonly string[],
  after: readonly string[],
  deps: RyzeLabelDeps = {},
): void {
  const { added, removed } = labelDelta(before, after);
  if (added.length === 0 && removed.length === 0) return;
  void withKeyedQueue(`ryze-labels:${gw.id}`, () =>
    syncNow(gw, conv.chatJid, before, after, deps),
  ).catch((err) => {
    logger.error(
      "ryze: label sync queue failed (gateway %s): %s",
      String(gw.id),
      describe(err),
    );
  });
}

/** Resolves once every label sync queued so far for this gateway has run (tests). */
export function drainLabelSyncs(gatewayId: bigint): Promise<void> {
  return withKeyedQueue(`ryze-labels:${gatewayId}`, async () => {});
}

/**
 * Applies automatic label rules to a conversation: the titles of live labels whose rule is in `add`
 * are put on, those in `remove` taken off. Announces the change to the bots and syncs it to
 * WhatsApp. Best-effort: logs and returns null on failure, and null when nothing changed.
 */
export async function applyLabelRules(
  gw: RyzeGateway,
  conversationId: bigint,
  rules: { add?: RyzeLabelAutoRule[]; remove?: RyzeLabelAutoRule[] },
  deps: RyzeLabelDeps = {},
): Promise<RyzeConversation | null> {
  const base = deps.base ?? basePrisma;
  const add = rules.add ?? [];
  const remove = rules.remove ?? [];
  if (add.length === 0 && remove.length === 0) return null;
  try {
    const out = await scoped(
      gw.tenantId,
      async (db) => {
        const ruled = await db.ryzeLabel.findMany({
          where: {
            gatewayId: gw.id,
            deletedAt: null,
            autoRule: { in: [...add, ...remove] },
          },
          select: { title: true, autoRule: true },
        });
        if (ruled.length === 0) return null;
        const conv = await db.ryzeConversation.findUnique({
          where: { id: conversationId },
        });
        if (!conv) return null;
        const drop = new Set(
          ruled
            .filter((r) => remove.includes(r.autoRule as RyzeLabelAutoRule))
            .map((r) => r.title),
        );
        const put = ruled
          .filter((r) => add.includes(r.autoRule as RyzeLabelAutoRule))
          .map((r) => r.title);
        const next = [
          ...conv.labels.filter((l) => !drop.has(l)),
          ...put.filter((t) => !conv.labels.includes(t) && !drop.has(t)),
        ];
        const delta = labelDelta(conv.labels, next);
        if (delta.added.length === 0 && delta.removed.length === 0) return null;
        const after = await db.ryzeConversation.update({
          where: { id: conv.id },
          data: { labels: next },
        });
        const body = await conversationBody(db, gw, after);
        return { before: conv.labels, after, body };
      },
      base,
    );
    if (!out) return null;
    emitToBots({ tenantId: gw.tenantId, gatewayId: gw.id, base }, [
      { ...out.body, event: "conversation_updated" },
    ]);
    syncConversationLabels(gw, out.after, out.before, out.after.labels, deps);
    return out.after;
  } catch (err) {
    logger.warn(
      "ryze: automatic labels not applied (gateway %s): %s",
      String(gw.id),
      describe(err),
    );
    return null;
  }
}

function tagIdOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function conversationForJid(
  db: ScopedDb,
  gatewayId: bigint,
  chatJid: string,
): Promise<RyzeConversation | null> {
  const jid = chatJid.includes("@") ? chatJid : `${chatJid}@s.whatsapp.net`;
  const found = await db.ryzeConversation.findUnique({
    where: { gatewayId_chatJid: { gatewayId, chatJid: jid } },
  });
  if (found) return found;
  const variant = brazilianNinthDigitVariant(jid);
  return variant
    ? db.ryzeConversation.findUnique({
        where: { gatewayId_chatJid: { gatewayId, chatJid: variant } },
      })
    : null;
}

/**
 * A `label.update` from RyzeAPI. `edit` refreshes (or imports, or deletes) the catalog row of that
 * WhatsApp id; `chat` is the team labelling a chat on the phone: the title moves on the conversation,
 * joins its `deviceLabels`, and is NOT synced back. Idempotent: an event that changes nothing (a
 * redelivery, or the echo of our own sync) announces nothing.
 *
 * A `human_takeover` label is also the handoff switch on the phone, for numbers with no Chatwoot
 * console: put on, the conversation opens (a human has it, the agent stops — `shouldBotHandle` only
 * answers `pending`); taken off an open conversation, it goes back to `pending` and the agent
 * answers again. The echo of our own takeover sync changes nothing, so it cannot flip it back.
 */
export async function handleLabelUpdate(
  gw: RyzeGateway,
  data: Record<string, unknown>,
  deps: RyzeLabelDeps = {},
): Promise<"accepted" | "ignored"> {
  const base = deps.base ?? basePrisma;
  const type = typeof data.type === "string" ? data.type : "";
  const tagId = tagIdOf(data.labelId);
  if (!tagId) return "ignored";
  if (type === "edit") {
    const deleted = data.deleted === true || data.action === "deleted";
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const color = typeof data.color === "number" ? data.color : Number.NaN;
    await mergeTags(
      gw,
      deleted
        ? [{ id: tagId, name: name || tagId, color: 0, deleted: true }]
        : name
          ? [{ id: tagId, name, color, deleted: false }]
          : [],
      base,
    );
    return "accepted";
  }
  if (type !== "chat") return "ignored";
  const chatJid = typeof data.chatJid === "string" ? data.chatJid : "";
  if (!chatJid || chatJid.endsWith("@g.us")) return "ignored";
  const adding =
    data.action === "add" ||
    (data.action !== "remove" && data.labeled === true);
  const findTitle = () =>
    scoped(
      gw.tenantId,
      (db) =>
        db.ryzeLabel.findFirst({
          where: { gatewayId: gw.id, tagId, deletedAt: null },
          select: { title: true, autoRule: true },
        }),
      base,
    );
  let label = await findTitle();
  if (!label) {
    await syncCatalogFromWhatsApp(gw, deps);
    label = await findTitle();
  }
  if (!label) return "ignored";
  const title = label.title;
  const takeover = label.autoRule === "human_takeover";
  const out = await scoped(
    gw.tenantId,
    async (db) => {
      const conv = await conversationForJid(db, gw.id, chatJid);
      if (!conv) return null;
      const has = conv.labels.includes(title);
      if (adding === has) return null;
      const status = !takeover
        ? null
        : adding
          ? conv.status === "open"
            ? null
            : "open"
          : conv.status === "open"
            ? "pending"
            : null;
      const after = await db.ryzeConversation.update({
        where: { id: conv.id },
        data: {
          labels: adding
            ? [...conv.labels, title]
            : conv.labels.filter((l) => l !== title),
          ...(conv.deviceLabels.includes(title)
            ? {}
            : { deviceLabels: [...conv.deviceLabels, title] }),
          ...(status ? { status } : {}),
        },
      });
      return { body: await conversationBody(db, gw, after), status };
    },
    base,
  );
  if (!out) return "ignored";
  // Same events as a status toggle from the console, so the takeover bookkeeping runs as usual.
  const events = out.status
    ? [
        "conversation_status_changed",
        ...(out.status === "open" ? ["conversation_opened"] : []),
        "conversation_updated",
      ]
    : ["conversation_updated"];
  emitToBots(
    { tenantId: gw.tenantId, gatewayId: gw.id, base },
    events.map((event) => ({ ...out.body, event })),
  );
  return "accepted";
}

/** What a turn on a Ryze conversation needs to know about labels (prompt block, protected titles). */
export async function ryzeLabelTurnContext(
  db: ScopedDb,
  instanceId: bigint,
  displayId: number,
): Promise<{
  catalog: { title: string; description: string | null }[];
  deviceLabels: string[];
} | null> {
  const gw = await db.ryzeGateway.findUnique({
    where: { chatwootInstanceId: instanceId },
    select: { id: true },
  });
  if (!gw) return null;
  const conv = await db.ryzeConversation.findUnique({
    where: { displayId },
    select: { gatewayId: true, deviceLabels: true },
  });
  const catalog = await db.ryzeLabel.findMany({
    where: { gatewayId: gw.id, deletedAt: null },
    orderBy: { id: "asc" },
    select: { title: true, description: true },
  });
  return {
    catalog,
    deviceLabels:
      conv && conv.gatewayId === gw.id ? [...conv.deviceLabels] : [],
  };
}

/** Live catalog titles of a gateway with their colors, for the emulated account label list. */
export function catalogTitles(
  db: ScopedDb,
  gatewayId: bigint,
): Promise<{ title: string; color: number }[]> {
  return db.ryzeLabel.findMany({
    where: { gatewayId, deletedAt: null },
    orderBy: { id: "asc" },
    select: { title: true, color: true },
  });
}
