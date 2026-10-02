import type {
  PrismaClient,
  RyzeConversation,
  RyzeGateway,
  RyzeMessage,
} from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
import {
  createRyzeClient,
  type RyzeClient,
  type RyzeSentMessage,
  ryzeRecipient,
} from "./client";
import { RYZE_OPERATOR_USER } from "./constants";
import { emitToBots } from "./emit";
import { presentMessageWebhook } from "./present";
import {
  conversationBody,
  conversationByDisplayId,
  openConversation,
  scoped,
  touchConversation,
  upsertContact,
} from "./store";

// Reply buttons on the RyzeAPI channel. OUT: a card sent by the operator's backend is stored as the
// agent's own message, so the model reads it and no human takeover is inferred. IN: a tap keeps its id
// in `content_attributes.button_reply`; an id with the bridge prefix is POSTed to the bridge and starts
// no agent turn, so an approval is decided by the click, never by a model reading "Aprovar".

const BRIDGE_TIMEOUT_MS = 5_000;
const MAX_BUTTONS = 3;
const BUTTON_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
// A code to copy (verification code, coupon): short and plain.
const COPY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMOJI_MAX = 16;
const TEXT_MAX = 4_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export interface ButtonReply {
  id: string;
  title: string | null;
  // The card the tap answers, when RyzeAPI says so (the tap quotes the original message).
  cardExternalId: string | null;
}

// The RyzeAPI docs describe the tap in two shapes that do not agree (the "Send buttons" note and the
// event catalog), and a list selection in a third; every one of them is read here.
export function buttonReplyOf(
  msg: Record<string, unknown>,
): ButtonReply | null {
  const button = isRecord(msg.button_response) ? msg.button_response : null;
  const list = isRecord(msg.list_response) ? msg.list_response : null;
  const interactive = isRecord(msg.interactive) ? msg.interactive : null;
  const content = isRecord(msg.content) ? msg.content : null;
  const reply = isRecord(msg.reply) ? msg.reply : null;
  const single =
    list && isRecord(list.single_select_reply)
      ? list.single_select_reply
      : null;
  const type = str(msg.type);
  const id =
    str(button?.selected_button_id) ??
    str(interactive?.selectedButtonId) ??
    str(single?.option_name) ??
    (type === "template_button_reply" || type === "buttons_response"
      ? (str(content?.text) ?? str(msg.content))
      : null);
  if (!id || !BUTTON_ID_RE.test(id)) return null;
  return {
    id,
    title: str(button?.title) ?? str(list?.title) ?? str(interactive?.title),
    cardExternalId:
      (reply ? str(reply.message_id) : null) ??
      str(button?.message_id) ??
      str(interactive?.messageId),
  };
}

export function bridgeClaims(reply: ButtonReply): boolean {
  const { url, secret, prefix } = config.ryzeButtonBridge;
  return !!url && !!secret && !!prefix && reply.id.startsWith(prefix);
}

function clientFor(gw: RyzeGateway): Promise<RyzeClient> {
  return createRyzeClient({
    baseUrl: gw.baseUrl,
    instance: gw.instanceName,
    token: decryptJson<string>(gw.token),
  });
}

function phoneOf(chatJid: string): string {
  return chatJid.split("@")[0] ?? "";
}

// An outgoing row that belongs to the agent: the bound bot when there is one, else the operator.
function agentSender(gw: RyzeGateway) {
  return gw.agentBotId !== null
    ? {
        senderType: "agent_bot",
        senderId: gw.agentBotId,
        senderName: gw.inboxName,
      }
    : {
        senderType: "user",
        senderId: RYZE_OPERATOR_USER.id,
        senderName: RYZE_OPERATOR_USER.name,
      };
}

async function storeOutgoing(
  db: ScopedDb,
  gw: RyzeGateway,
  conv: RyzeConversation,
  content: string,
  contentAttributes: Record<string, unknown>,
): Promise<RyzeMessage> {
  return db.ryzeMessage.create({
    data: {
      tenantId: gw.tenantId,
      gatewayId: gw.id,
      conversationId: conv.displayId,
      messageType: 1,
      content,
      contentAttributes: contentAttributes as object,
      attachments: [] as unknown as object,
      ...agentSender(gw),
      status: "sending",
    },
  });
}

async function landAndEcho(
  gw: RyzeGateway,
  row: RyzeMessage,
  externalId: string | null,
  base: PrismaClient,
): Promise<RyzeMessage> {
  const { done, body } = await scoped(
    gw.tenantId,
    async (db) => {
      const done = await db.ryzeMessage.update({
        where: { id: row.id },
        data: { externalId, status: "sent" },
      });
      const conv = await conversationByDisplayId(db, gw.id, row.conversationId);
      const touched = conv ? await touchConversation(db, conv) : null;
      return {
        done,
        body: touched ? await conversationBody(db, gw, touched) : null,
      };
    },
    base,
  );
  if (body) {
    emitToBots({ tenantId: gw.tenantId, gatewayId: gw.id, base }, [
      presentMessageWebhook("message_created", done, body, gw),
    ]);
  }
  return done;
}

export interface CardInput {
  to: string;
  text: string;
  header?: string;
  footer?: string;
  // Image shown with the card (https only), e.g. the artwork waiting for approval.
  mediaUrl?: string;
  // Reply buttons (id, tap comes back), or link (url, opens the page) and copy (copy, copies a code)
  // buttons; never reply mixed with the others, because WhatsApp Web/Desktop hides it.
  buttons: { id?: string; url?: string; copy?: string; title: string }[];
}

export interface TextInput {
  to: string;
  text: string;
}

export interface SentMessage {
  messageId: string | null;
  conversationId: number;
}

interface SendDeps {
  base?: PrismaClient;
  makeClient?: (gw: RyzeGateway) => Promise<RyzeClient>;
}

function validateRecipientAndText(to: string, text: string, what: string) {
  if (!/^\d{10,15}$/.test(to)) throw new AppError("invalid recipient", 400);
  if (!text.trim() || text.length > TEXT_MAX)
    throw new AppError(`invalid ${what} text`, 400);
}

function isHttpsMediaUrl(raw: string): boolean {
  if (raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateCard(card: CardInput): void {
  validateRecipientAndText(card.to, card.text, "card");
  if (card.buttons.length < 1 || card.buttons.length > MAX_BUTTONS)
    throw new AppError("a card takes 1 to 3 buttons", 400);
  const replies = card.buttons.filter((b) => b.id !== undefined).length;
  if (replies > 0 && replies !== card.buttons.length)
    throw new AppError(
      "a card takes reply buttons or link/copy buttons, not both",
      400,
    );
  for (const b of card.buttons) {
    const kinds = [b.id, b.url, b.copy].filter((v) => v !== undefined).length;
    const target =
      kinds === 1 &&
      (b.url !== undefined
        ? isHttpsMediaUrl(b.url)
        : b.copy !== undefined
          ? COPY_RE.test(b.copy)
          : BUTTON_ID_RE.test(b.id ?? ""));
    if (!target || !b.title.trim() || b.title.length > 20)
      throw new AppError("invalid button", 400);
  }
  if (card.mediaUrl !== undefined && !isHttpsMediaUrl(card.mediaUrl))
    throw new AppError("invalid media url", 400);
}

export function validateText(msg: TextInput): void {
  validateRecipientAndText(msg.to, msg.text, "message");
}

// The buttons a reply sent through the emulator carries (`content_attributes.buttons`, written by
// send_buttons), checked by the same rules as an admin card: 1 to 3, reply OR link, titles of up to 20
// characters. Copy buttons are the operator's, not the agent's. Null when there are none or they fail
// the rules: the reply then goes out as plain text, which beats a reply that does not go at all.
export function cardButtonsOf(
  bag: unknown,
  chatJid: string,
  text: string,
): CardInput["buttons"] | null {
  if (!bag || typeof bag !== "object") return null;
  const raw = (bag as { buttons?: unknown }).buttons;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const buttons: CardInput["buttons"] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") return null;
    const { id, url, title } = b as Record<string, unknown>;
    if (typeof title !== "string") return null;
    if (typeof id === "string" && url === undefined)
      buttons.push({ id, title });
    else if (typeof url === "string" && id === undefined)
      buttons.push({ url, title });
    else return null;
  }
  try {
    validateCard({
      to: ryzeRecipient(chatJid).replace(/\D/g, ""),
      text,
      buttons,
    });
    return buttons;
  } catch (err) {
    logger.warn(
      "ryze: reply buttons refused, sending the text alone: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// Stages the agent-owned row in the contact's conversation on this number (a Brazilian mobile
// reuses the contact stored with or without the ninth digit), sends it, then lands and echoes it.
// A send that fails removes the staged row, so the history never shows a message that did not go.
async function sendAsAgent(
  ctx: TenantContext,
  gatewayInstanceId: bigint,
  to: string,
  content: string,
  contentAttributes: Record<string, unknown>,
  send: (ryze: RyzeClient, chatJid: string) => Promise<RyzeSentMessage>,
  deps: SendDeps,
): Promise<SentMessage> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const base = deps.base ?? basePrisma;
  const staged = await scoped(
    tenantId,
    async (db) => {
      const gw = await db.ryzeGateway.findUnique({
        where: { chatwootInstanceId: gatewayInstanceId },
      });
      if (!gw) throw new NotFoundError("errors.ryzeGatewayNotFound");
      const contact = await upsertContact(db, gw, `${to}@s.whatsapp.net`, null);
      const { conv } = await openConversation(db, gw, contact);
      const row = await storeOutgoing(db, gw, conv, content, contentAttributes);
      return { gw, conv, row };
    },
    base,
  );
  try {
    const ryze = await (deps.makeClient ?? clientFor)(staged.gw);
    const sent = await send(ryze, staged.conv.chatJid);
    await landAndEcho(staged.gw, staged.row, sent.messageId, base);
    return { messageId: sent.messageId, conversationId: staged.conv.displayId };
  } catch (err) {
    await scoped(
      tenantId,
      (db) => db.ryzeMessage.delete({ where: { id: staged.row.id } }),
      base,
    );
    throw err;
  }
}

// OUT: send a card into the contact's conversation on this number.
export async function sendRyzeCard(
  ctx: TenantContext,
  gatewayInstanceId: bigint,
  card: CardInput,
  deps: SendDeps = {},
): Promise<SentMessage> {
  validateCard(card);
  const content = [
    card.header ? `*${card.header}*` : null,
    card.text,
    card.footer ?? null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return sendAsAgent(
    ctx,
    gatewayInstanceId,
    card.to,
    content,
    card.mediaUrl
      ? { buttons: card.buttons, mediaUrl: card.mediaUrl }
      : { buttons: card.buttons },
    (ryze, chatJid) => ryze.sendButtons(chatJid, card),
    deps,
  );
}

// OUT: send a plain text into the contact's conversation on this number, as the agent's own message.
export async function sendRyzeText(
  ctx: TenantContext,
  gatewayInstanceId: bigint,
  msg: TextInput,
  deps: SendDeps = {},
): Promise<SentMessage> {
  validateText(msg);
  return sendAsAgent(
    ctx,
    gatewayInstanceId,
    msg.to,
    msg.text,
    {},
    (ryze, chatJid) => ryze.sendText(chatJid, msg.text),
    deps,
  );
}

interface BridgeAnswer {
  react: { messageId: string; emoji: string } | null;
  text: string | null;
}

function readBridgeAnswer(raw: unknown): BridgeAnswer {
  const body = isRecord(raw) ? raw : {};
  const react = isRecord(body.react) ? body.react : null;
  const emoji = str(react?.emoji);
  const messageId = str(react?.messageId);
  const text = str(body.text);
  return {
    react:
      emoji && messageId && emoji.length <= EMOJI_MAX
        ? { messageId, emoji }
        : null,
    text: text && text.length <= TEXT_MAX ? text : null,
  };
}

// IN: forward a claimed tap to the bridge and carry out what it answers (a reaction on the card, a
// short text). Called after the tap is stored and INSTEAD of emitting it to the bots. Never throws:
// a bridge that is down leaves the tap stored and unanswered, which is the safe side for an approval.
export async function forwardButtonReply(
  gw: RyzeGateway,
  conv: RyzeConversation,
  tap: { externalId: string; reply: ButtonReply },
  deps: {
    base?: PrismaClient;
    fetchImpl?: typeof fetch;
    makeClient?: (gw: RyzeGateway) => Promise<RyzeClient>;
  } = {},
): Promise<void> {
  const base = deps.base ?? basePrisma;
  const { url, secret } = config.ryzeButtonBridge;
  let answer: BridgeAnswer;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-key": secret },
      body: JSON.stringify({
        instanceName: gw.instanceName,
        phone: phoneOf(conv.chatJid),
        conversationId: conv.displayId,
        messageId: tap.externalId,
        buttonId: tap.reply.id,
        buttonTitle: tap.reply.title,
        cardMessageId: tap.reply.cardExternalId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        "ryze bridge: answered %d for gateway %s",
        res.status,
        String(gw.id),
      );
      return;
    }
    answer = readBridgeAnswer(await res.json().catch(() => null));
  } catch (err) {
    logger.warn(
      "ryze bridge: call failed for gateway %s: %s",
      String(gw.id),
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  try {
    const ryze = await (deps.makeClient ?? clientFor)(gw);
    if (answer.react) {
      await ryze.sendReaction(
        conv.chatJid,
        answer.react.messageId,
        answer.react.emoji,
      );
    }
    if (answer.text) {
      const row = await scoped(
        gw.tenantId,
        (db) => storeOutgoing(db, gw, conv, answer.text as string, {}),
        base,
      );
      const sent = await ryze.sendText(conv.chatJid, answer.text);
      await landAndEcho(gw, row, sent.messageId, base);
    }
  } catch (err) {
    logger.warn(
      "ryze bridge: follow-up failed for gateway %s: %s",
      String(gw.id),
      err instanceof Error ? err.message : String(err),
    );
  }
}
