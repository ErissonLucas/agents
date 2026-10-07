import { timingSafeEqual } from "node:crypto";
import type {
  PrismaClient,
  RyzeGateway,
  RyzeMessage,
} from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { asSuperAdminOn, type ScopedDb } from "@/lib/tenancy";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import { RYZE_SOURCE } from "./client";
import {
  RYZE_CONNECTED_STATE,
  RYZE_DEVICE_SENDER_NAME,
  ryzeEmulatorBaseUrl,
} from "./constants";
import { emitToBots } from "./emit";
import { bridgeClaims, buttonReplyOf, forwardButtonReply } from "./interactive";
import { applyLabelRules, handleLabelUpdate } from "./labels";
import { presentMessageWebhook, type StoredAttachment } from "./present";
import {
  conversationBody,
  openConversation,
  scoped,
  touchConversation,
  upsertContact,
} from "./store";

// RyzeAPI webhook receiver. Authenticated by the route token in the path (resolves the gateway) and
// the static Authorization value we configured on the gateway (Ryze does not sign). A customer
// message becomes an emulated `message_created` incoming; a message typed on the paired phone becomes
// the device-reply shape; our own sends coming back are dropped. Groups are ignored. A `label.update`
// is the team labelling on the phone (see labels.ts).

export interface RyzeWebhookResult {
  status: number;
  outcome: "accepted" | "ignored" | "duplicate" | "unauthorized";
}

const ECHO_WINDOW_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The chat key: the phone JID when there is one, else the lid, always with its domain, so a bare
// number from one event and a full JID from another land on the same conversation.
export function chatKey(chat: Record<string, unknown>): string | null {
  const jid = str(chat.jid);
  const lid = str(chat.lid);
  const raw = jid ?? lid;
  if (!raw) return null;
  return raw.includes("@") ? raw : `${raw}@s.whatsapp.net`;
}

async function resolveGateway(
  routeToken: string,
  base: PrismaClient,
): Promise<RyzeGateway | null> {
  const hash = hashRouteToken(routeToken);
  return asSuperAdminOn(base, (db) =>
    db.ryzeGateway.findUnique({ where: { webhookRouteTokenHash: hash } }),
  );
}

export interface InboundMedia {
  fileType: string;
  mime: string | null;
  fileName: string | null;
  bytes: Uint8Array<ArrayBuffer> | null;
}

const FILE_TYPE_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  image: "image",
  sticker: "image",
  audio: "audio",
  ptt: "audio",
  voice: "audio",
  video: "video",
  ptv: "video",
  document: "file",
  file: "file",
};

function fileTypeOfMime(mime: string | null): string | null {
  const m = mime?.toLowerCase() ?? "";
  // NOTE: no MIME, or the generic octet-stream, says nothing about the kind.
  if (m === "" || m.startsWith("application/octet-stream")) return null;
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return "file";
}

// The kind a stored attachment is read as (and so whether STT runs on it). The MIME decides when it
// names one, because the live gateway's `media.type` is not always a value of the set above; the type
// decides when the MIME is missing or generic, with a `…Message` suffix read as the bare kind.
export function inboundMedia(
  msg: Record<string, unknown>,
): InboundMedia | null {
  const media = isRecord(msg.media) ? msg.media : null;
  if (!media) return null;
  const mime = str(media.mimetype) ?? str(media.mimeType) ?? str(media.mime);
  const type = (str(media.type) ?? "").toLowerCase().replace(/message$/, "");
  const fileType =
    fileTypeOfMime(mime) ?? FILE_TYPE_BY_MEDIA_TYPE[type] ?? "file";
  const b64 = str(media.base64);
  return {
    fileType,
    mime,
    fileName: str(media.fileName),
    bytes: b64
      ? new Uint8Array(Buffer.from(b64.replace(/^data:[^,]*,/, ""), "base64"))
      : null,
  };
}

// A live message.exchange carries chat, sender, direction, id and timestamp on `data`, beside
// `data.message` (type, content as a plain string, interactive, reaction...); the docs' catalog nests
// them inside `message`. Both are read: the inner keys win where both have a value.
export function exchangeMessage(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const inner = isRecord(data.message) ? data.message : null;
  if (!inner) return null;
  const merged: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(inner)) {
    if (v !== null && v !== undefined && v !== "") merged[k] = v;
  }
  delete merged.message;
  return merged;
}

function textOf(msg: Record<string, unknown>): string | null {
  const content = isRecord(msg.content) ? msg.content : null;
  const media = isRecord(msg.media) ? msg.media : null;
  const location = isRecord(msg.location) ? msg.location : null;
  return (
    str(content?.text) ??
    str(msg.content) ??
    str(media?.caption) ??
    (location ? str(location.address) : null)
  );
}

function reactionOf(
  msg: Record<string, unknown>,
): { emoji: string; targetId: string | null } | null {
  const reaction = isRecord(msg.reaction) ? msg.reaction : null;
  if (reaction) {
    return {
      emoji: str(reaction.text) ?? str(reaction.emoji) ?? "",
      targetId:
        str(reaction.message_id) ??
        str(reaction.messageId) ??
        str(reaction.key),
    };
  }
  if (str(msg.type) === "reaction") {
    const content = isRecord(msg.content) ? msg.content : null;
    const reply = isRecord(msg.reply) ? msg.reply : null;
    return {
      emoji: str(content?.text) ?? "",
      targetId: reply ? str(reply.message_id) : null,
    };
  }
  return null;
}

async function internalIdOf(
  db: ScopedDb,
  gatewayId: bigint,
  externalId: string | null,
): Promise<number | null> {
  if (!externalId) return null;
  const row = await db.ryzeMessage.findUnique({
    where: { gatewayId_externalId: { gatewayId, externalId } },
    select: { messageId: true },
  });
  return row?.messageId ?? null;
}

// The label of a tapped button, read off the card we sent: a live tap carries only the id.
async function cardButtonTitle(
  db: ScopedDb,
  gatewayId: bigint,
  conversationId: number,
  buttonId: string,
): Promise<string | null> {
  const recent = await db.ryzeMessage.findMany({
    where: { gatewayId, conversationId, messageType: 1 },
    orderBy: { messageId: "desc" },
    take: 20,
    select: { contentAttributes: true },
  });
  for (const row of recent) {
    const attrs = isRecord(row.contentAttributes) ? row.contentAttributes : {};
    const buttons = Array.isArray(attrs.buttons) ? attrs.buttons : [];
    for (const b of buttons) {
      if (isRecord(b) && b.id === buttonId && typeof b.title === "string")
        return b.title;
    }
    // A carousel card's button reads as the button AND the card it sits on ("Quero esse — Trio
    // Ternura"): every card shows the same button, so the title alone would not say which one.
    const cards = Array.isArray(attrs.carousel) ? attrs.carousel : [];
    for (const c of cards) {
      if (
        isRecord(c) &&
        c.id === buttonId &&
        typeof c.buttonTitle === "string" &&
        typeof c.title === "string"
      )
        return `${c.buttonTitle} — ${c.title}`;
    }
  }
  return null;
}

// An outgoing message with no source of ours is our own send only if it is one we already hold:
// by the gateway id Ryze returned, or (the send's response still in flight) by the same text on a
// send of ours in the last minute that has no gateway id yet.
async function adoptOwnEcho(
  db: ScopedDb,
  gw: RyzeGateway,
  conversationId: number,
  externalId: string,
  text: string | null,
): Promise<boolean> {
  if ((await internalIdOf(db, gw.id, externalId)) !== null) return true;
  if (!text) return false;
  const pending = await db.ryzeMessage.findFirst({
    where: {
      gatewayId: gw.id,
      conversationId,
      messageType: 1,
      externalId: null,
      content: text,
      senderType: { not: null },
      createdAt: { gte: new Date(Date.now() - ECHO_WINDOW_MS) },
    },
    orderBy: { messageId: "desc" },
  });
  if (!pending) return false;
  await db.ryzeMessage.update({
    where: { id: pending.id },
    data: { externalId },
  });
  return true;
}

async function handleInstanceState(
  gw: RyzeGateway,
  data: Record<string, unknown>,
  base: PrismaClient,
): Promise<void> {
  const state = str(data.state);
  if (!state) return;
  const jid = str(data.jid);
  // Set when a number pairs (none before, or another one takes the instance). A gateway that already
  // had its number before the column existed keeps null, and with it the old new_conversation rule.
  const firstConnect =
    state === RYZE_CONNECTED_STATE &&
    ((!!jid && jid !== gw.numberJid) || (!gw.connectedAt && !gw.numberJid));
  await scoped(
    gw.tenantId,
    (db) =>
      db.ryzeGateway.update({
        where: { id: gw.id },
        data: {
          connectionState: state,
          ...(jid ? { numberJid: jid } : {}),
          ...(firstConnect ? { connectedAt: new Date() } : {}),
          lastEventAt: new Date(),
        },
      }),
    base,
  );
}

async function handleMessage(
  gw: RyzeGateway,
  data: Record<string, unknown>,
  base: PrismaClient,
): Promise<RyzeWebhookResult> {
  const msg = exchangeMessage(data);
  if (!msg) return { status: 200, outcome: "ignored" };
  const chat = isRecord(msg.chat) ? msg.chat : {};
  if (str(chat.type) && str(chat.type) !== "private") {
    return { status: 200, outcome: "ignored" };
  }
  if (str(msg.type) === "message_revoke" || isRecord(msg.edit)) {
    return { status: 200, outcome: "ignored" };
  }
  const key = chatKey(chat);
  const externalId = str(msg.id) ?? str(data.id);
  if (!key || !externalId) return { status: 200, outcome: "ignored" };
  const outgoing = str(msg.direction) === "outgoing";
  if (outgoing && str(msg.source) === RYZE_SOURCE) {
    return { status: 200, outcome: "ignored" };
  }
  // Another system sending through this number (config.ryzeAutomationSources): kept in the history,
  // but shaped like an automation rule's send, so it is not a person taking the conversation over.
  const automationSource =
    outgoing && config.ryzeAutomationSources.includes(str(msg.source) ?? "")
      ? str(msg.source)
      : null;

  const sender = isRecord(msg.sender) ? msg.sender : {};
  const text = textOf(msg);
  const media = inboundMedia(msg);
  const reaction = reactionOf(msg);
  // A reaction sent from this number (ours, or tapped on the paired phone) answers nothing and is not a
  // person taking the conversation over.
  if (outgoing && reaction) return { status: 200, outcome: "ignored" };
  const buttonReply = outgoing || reaction ? null : buttonReplyOf(msg);
  const bridged = !!buttonReply && bridgeClaims(buttonReply);
  const root = ryzeEmulatorBaseUrl(gw.chatwootInstanceId);
  const sentAt = str(msg.timestamp)
    ? new Date(str(msg.timestamp) as string)
    : new Date();
  // History older than the connection: the chat existed before the number came to us.
  const beforeConnection =
    !!gw.connectedAt &&
    !Number.isNaN(sentAt.getTime()) &&
    sentAt < gw.connectedAt;

  const out = await scoped(
    gw.tenantId,
    async (db) => {
      const dup = await internalIdOf(db, gw.id, externalId);
      if (dup !== null) return { kind: "duplicate" as const };
      const contact = await upsertContact(
        db,
        gw,
        key,
        outgoing ? null : (str(sender.name) ?? str(chat.name)),
      );
      const opened = await openConversation(db, gw, contact);
      let conv = opened.conv;
      if (
        outgoing &&
        (await adoptOwnEcho(db, gw, conv.displayId, externalId, text))
      ) {
        return { kind: "duplicate" as const };
      }
      const reply = isRecord(msg.reply) ? msg.reply : null;
      const inReplyTo = await internalIdOf(
        db,
        gw.id,
        reaction?.targetId ?? (reply ? str(reply.message_id) : null),
      );
      // What we sent wins over what WhatsApp echoes: a carousel shows the same button on every card,
      // so only our record says which card was tapped. Plain buttons read the same either way.
      const buttonTitle = buttonReply
        ? ((await cardButtonTitle(db, gw.id, conv.displayId, buttonReply.id)) ??
          buttonReply.title ??
          null)
        : null;
      const contentAttributes: Record<string, unknown> = {
        ...(inReplyTo !== null ? { in_reply_to: inReplyTo } : {}),
        ...(reaction ? { is_reaction: true } : {}),
        ...(buttonReply
          ? { button_reply: { id: buttonReply.id, title: buttonTitle } }
          : {}),
        ...(automationSource
          ? { automation_source: automationSource }
          : outgoing
            ? {
                external_sender_name: RYZE_DEVICE_SENDER_NAME,
                external_created_at: Math.floor(Date.now() / 1000),
              }
            : {}),
      };
      const created = await db.ryzeMessage.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          conversationId: conv.displayId,
          messageType: outgoing ? 1 : 0,
          // A tap reads as the button the contact saw, not as its id.
          content: reaction
            ? reaction.emoji
            : buttonReply
              ? (buttonTitle ??
                (bridged ? "[botão]" : `[botão] ${buttonReply.id}`))
              : text,
          contentAttributes: contentAttributes as object,
          ...(outgoing
            ? {}
            : {
                senderType: "contact",
                senderId: contact.contactId,
                senderName: contact.name,
              }),
          externalId,
          createdAt: sentAt,
        },
      });
      let row: RyzeMessage = created;
      if (media && !reaction) {
        const mediaRow = await db.ryzeMedia.create({
          data: {
            tenantId: gw.tenantId,
            gatewayId: gw.id,
            messageId: created.messageId,
            fileType: media.fileType,
            mime: media.mime,
            fileName: media.fileName,
            bytes: media.bytes,
            externalMessageId: externalId,
          },
        });
        const attachment: StoredAttachment = {
          id: mediaRow.attachmentId,
          file_type: media.fileType,
          data_url: `${root}/media/${mediaRow.attachmentId}`,
          file_name: media.fileName,
          meta: {},
        };
        row = await db.ryzeMessage.update({
          where: { id: created.id },
          data: { attachments: [attachment] as unknown as object },
        });
      }
      conv = await touchConversation(db, conv);
      const body = await conversationBody(db, gw, conv);
      return {
        kind: "stored" as const,
        conv,
        row,
        body,
        created: opened.created,
        reopened: opened.reopened,
      };
    },
    base,
  );

  if (out.kind === "duplicate") return { status: 200, outcome: "duplicate" };
  if (bridged && buttonReply) {
    // The tap is the decision: the bridge answers it, and no agent turn starts.
    await forwardButtonReply(
      gw,
      out.conv,
      { externalId, reply: buttonReply },
      { base },
    );
    return { status: 200, outcome: "accepted" };
  }
  const payloads: unknown[] = [];
  if (out.reopened) {
    payloads.push({ ...out.body, event: "conversation_status_changed" });
  }
  payloads.push(
    presentMessageWebhook("message_created", out.row, out.body, gw),
  );
  emitToBots({ tenantId: gw.tenantId, gatewayId: gw.id, base }, payloads);
  if (!outgoing) {
    await applyLabelRules(
      gw,
      out.conv.id,
      {
        add: out.created && !beforeConnection ? ["new_conversation"] : [],
        remove: [
          ...(reaction ? [] : (["clear_on_reply"] as const)),
          ...(out.reopened ? (["human_takeover"] as const) : []),
        ],
      },
      { base },
    );
  }
  return { status: 200, outcome: "accepted" };
}

export async function receiveRyzeWebhook(params: {
  routeToken: string;
  rawBody: string;
  authorization: string | null;
  base?: PrismaClient;
}): Promise<RyzeWebhookResult> {
  const base = params.base ?? basePrisma;
  const gw = await resolveGateway(params.routeToken, base);
  if (
    !gw ||
    !params.authorization ||
    !safeEqual(params.authorization, decryptJson<string>(gw.webhookAuth))
  ) {
    return { status: 401, outcome: "unauthorized" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    return { status: 400, outcome: "ignored" };
  }
  if (!isRecord(payload)) return { status: 400, outcome: "ignored" };
  const event = str(payload.event);
  const data = isRecord(payload.data) ? payload.data : {};
  try {
    if (event === "instance.state") {
      await handleInstanceState(gw, data, base);
      return { status: 200, outcome: "accepted" };
    }
    if (event === "message.exchange")
      return await handleMessage(gw, data, base);
    if (event === "label.update") {
      const outcome = await handleLabelUpdate(gw, data, { base });
      return { status: 200, outcome };
    }
  } catch (err) {
    logger.error(
      "ryze: webhook %s failed for gateway %s: %s",
      event,
      String(gw.id),
      err instanceof Error ? err.message : String(err),
    );
    return { status: 500, outcome: "ignored" };
  }
  return { status: 200, outcome: "ignored" };
}
