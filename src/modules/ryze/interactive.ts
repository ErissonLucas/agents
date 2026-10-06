import type {
  PrismaClient,
  RyzeContact,
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
import {
  RYZE_EMULATED_ACCOUNT_ID,
  RYZE_OPERATOR_USER,
  ryzeEmulatorBaseUrl,
} from "./constants";
import { emitToBots } from "./emit";
import { RyzeEmulator } from "./emulator";
import { labelSlug, sameLabelTitle } from "./label-shared";
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

// The configured bridge whose prefix this tap's id starts with (the longest when two match), or null.
export function bridgeFor(
  reply: ButtonReply,
): { url: string; secret: string; prefix: string } | null {
  const live = [config.ryzeButtonBridge, config.ryzeButtonBridge2].filter(
    (b) => !!b.url && !!b.secret && !!b.prefix && reply.id.startsWith(b.prefix),
  );
  live.sort((a, b) => b.prefix.length - a.prefix.length);
  return live[0] ?? null;
}

export function bridgeClaims(reply: ButtonReply): boolean {
  return bridgeFor(reply) !== null;
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

// What a send can write on the conversation before the message goes: the contact's name (only when
// it has none), custom attributes of the contact and of the conversation (merged into what is
// there), and labels added to the conversation (never removed). Every field is optional.
export interface ConversationContextInput {
  contactName?: string;
  contactAttributes?: Record<string, AttributeValue>;
  conversationAttributes?: Record<string, AttributeValue>;
  labels?: string[];
}

export type AttributeValue = string | number | boolean;

export const CONTEXT_ATTRIBUTES_MAX = 50;
export const CONTEXT_ATTRIBUTE_VALUE_MAX = 1_000;
export const CONTEXT_LABELS_MAX = 10;
export const CONTEXT_CONTACT_NAME_MAX = 255;
const ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface CardInput extends ConversationContextInput {
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

export interface TextInput extends ConversationContextInput {
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

export const CAROUSEL_MIN_CARDS = 2;
export const CAROUSEL_MAX_CARDS = 5;
const CAROUSEL_TITLE_MAX = 60;
const CAROUSEL_TEXT_MAX = 300;
const CAROUSEL_FOOTER_MAX = 60;

export interface CarouselCardInput {
  id: string;
  title: string;
  text: string;
  footer?: string;
  imageUrl: string;
  buttonTitle: string;
}

// The carousel a reply sent through the emulator carries (`content_attributes.carousel`, written by
// send_carousel): 2 to 5 cards, each with an https photo, a title, a text, an optional footer and one
// reply button with a distinct id. Null when there is none or it breaks a rule: the reply then goes
// out as plain text, which beats a reply that does not go at all.
export function carouselCardsOf(
  bag: unknown,
  text: string,
): CarouselCardInput[] | null {
  if (!bag || typeof bag !== "object") return null;
  const raw = (bag as { carousel?: unknown }).carousel;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const refuse = (why: string) => {
    logger.warn(
      "ryze: reply carousel refused, sending the text alone: %s",
      why,
    );
    return null;
  };
  if (!text.trim() || text.length > TEXT_MAX)
    return refuse("invalid message text");
  if (raw.length < CAROUSEL_MIN_CARDS || raw.length > CAROUSEL_MAX_CARDS)
    return refuse(
      `a carousel takes ${CAROUSEL_MIN_CARDS} to ${CAROUSEL_MAX_CARDS} cards`,
    );
  const cards: CarouselCardInput[] = [];
  const ids = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== "object") return refuse("invalid card");
    const {
      id,
      title,
      text: body,
      footer,
      imageUrl,
      buttonTitle,
    } = c as Record<string, unknown>;
    if (typeof id !== "string" || !BUTTON_ID_RE.test(id) || ids.has(id))
      return refuse("invalid card id");
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > CAROUSEL_TITLE_MAX
    )
      return refuse("invalid card title");
    if (
      typeof body !== "string" ||
      !body.trim() ||
      body.length > CAROUSEL_TEXT_MAX
    )
      return refuse("invalid card text");
    if (
      footer !== undefined &&
      (typeof footer !== "string" || footer.length > CAROUSEL_FOOTER_MAX)
    )
      return refuse("invalid card footer");
    if (typeof imageUrl !== "string" || !isHttpsMediaUrl(imageUrl))
      return refuse("invalid card image");
    if (
      typeof buttonTitle !== "string" ||
      !buttonTitle.trim() ||
      buttonTitle.length > 20
    )
      return refuse("invalid card button");
    ids.add(id);
    cards.push({
      id,
      title,
      text: body,
      imageUrl,
      buttonTitle,
      ...(footer ? { footer } : {}),
    });
  }
  return cards;
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

function validateAttributes(
  bag: Record<string, AttributeValue> | undefined,
  what: string,
): void {
  if (bag === undefined) return;
  if (typeof bag !== "object" || bag === null || Array.isArray(bag))
    throw new AppError(`invalid ${what} attributes`, 400);
  const entries = Object.entries(bag);
  if (entries.length > CONTEXT_ATTRIBUTES_MAX)
    throw new AppError(
      `${what} attributes take at most ${CONTEXT_ATTRIBUTES_MAX} keys`,
      400,
    );
  for (const [key, value] of entries) {
    if (!ATTRIBUTE_KEY_RE.test(key) || key === "__proto__")
      throw new AppError(`invalid ${what} attribute key`, 400);
    const ok =
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" &&
        value.length <= CONTEXT_ATTRIBUTE_VALUE_MAX);
    if (!ok) throw new AppError(`invalid ${what} attribute value`, 400);
  }
}

// A label is added under the title the rest of the channel uses: the slug form (a-z 0-9 _ -, up
// to 40), which is what a catalog row's title and a WhatsApp tag sync are keyed on.
export function validateConversationContext(
  input: ConversationContextInput,
): void {
  if (input.contactName !== undefined) {
    const name = input.contactName.trim();
    if (!name || input.contactName.length > CONTEXT_CONTACT_NAME_MAX)
      throw new AppError("invalid contact name", 400);
  }
  validateAttributes(input.contactAttributes, "contact");
  validateAttributes(input.conversationAttributes, "conversation");
  if (input.labels !== undefined) {
    if (
      !Array.isArray(input.labels) ||
      input.labels.length > CONTEXT_LABELS_MAX
    )
      throw new AppError(
        `labels take at most ${CONTEXT_LABELS_MAX} titles`,
        400,
      );
    for (const l of input.labels) {
      if (typeof l !== "string" || l.length === 0 || labelSlug(l) !== l)
        throw new AppError("invalid label", 400);
    }
  }
}

function hasContext(input: ConversationContextInput): boolean {
  return (
    input.contactName !== undefined ||
    (input.contactAttributes !== undefined &&
      Object.keys(input.contactAttributes).length > 0) ||
    (input.conversationAttributes !== undefined &&
      Object.keys(input.conversationAttributes).length > 0) ||
    (input.labels !== undefined && input.labels.length > 0)
  );
}

function bagOf(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// Writes the context through the emulated Chatwoot, the same routes the runtime calls: PUT contact,
// POST conversation custom_attributes, POST conversation labels. Those replace what they are given,
// so each is sent the stored bag or set with the new keys merged in, like `ChatwootClient` does.
// The label route persists first and queues the WhatsApp sync, which never fails the write.
async function applyConversationContext(
  gw: RyzeGateway,
  contact: RyzeContact,
  conv: RyzeConversation,
  input: ConversationContextInput,
  deps: SendDeps,
): Promise<void> {
  const emulator = new RyzeEmulator(gw.tenantId, gw.chatwootInstanceId, {
    base: deps.base,
    makeRyzeClient: deps.makeClient,
  });
  const root = `${ryzeEmulatorBaseUrl(gw.chatwootInstanceId)}/api/v1/accounts/${RYZE_EMULATED_ACCOUNT_ID}`;
  const call = async (method: string, path: string, body: unknown) => {
    const res = await emulator.fetch(`${root}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new AppError(
        `conversation context not applied (${method} ${path}: ${res.status})`,
        500,
      );
  };

  const setName = input.contactName !== undefined && !contact.name;
  const contactAttrs = input.contactAttributes ?? {};
  if (setName || Object.keys(contactAttrs).length > 0) {
    await call("PUT", `/contacts/${contact.contactId}`, {
      ...(setName ? { name: input.contactName?.trim() } : {}),
      custom_attributes: {
        ...bagOf(contact.customAttributes),
        ...contactAttrs,
      },
    });
  }
  const convAttrs = input.conversationAttributes ?? {};
  if (Object.keys(convAttrs).length > 0) {
    await call("POST", `/conversations/${conv.displayId}/custom_attributes`, {
      custom_attributes: { ...bagOf(conv.customAttributes), ...convAttrs },
    });
  }
  const added = (input.labels ?? []).filter(
    (l, i, all) =>
      all.indexOf(l) === i && !conv.labels.some((c) => sameLabelTitle(c, l)),
  );
  if (added.length > 0) {
    await call("POST", `/conversations/${conv.displayId}/labels`, {
      labels: [...conv.labels, ...added],
    });
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
  context: ConversationContextInput,
  deps: SendDeps,
): Promise<SentMessage> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const base = deps.base ?? basePrisma;
  const withContext = hasContext(context);
  const staged = await scoped(
    tenantId,
    async (db) => {
      const gw = await db.ryzeGateway.findUnique({
        where: { chatwootInstanceId: gatewayInstanceId },
      });
      if (!gw) throw new NotFoundError("errors.ryzeGatewayNotFound");
      const contact = await upsertContact(db, gw, `${to}@s.whatsapp.net`, null);
      const { conv } = await openConversation(db, gw, contact);
      const row = withContext
        ? null
        : await storeOutgoing(db, gw, conv, content, contentAttributes);
      return { gw, contact, conv, row };
    },
    base,
  );
  // NOTE: with context, the contact and conversation are committed first so the emulator's own
  // transactions see them, and the message row is staged only once the context is written.
  let row = staged.row;
  if (!row) {
    await applyConversationContext(
      staged.gw,
      staged.contact,
      staged.conv,
      context,
      { ...deps, base },
    );
    row = await scoped(
      tenantId,
      (db) =>
        storeOutgoing(db, staged.gw, staged.conv, content, contentAttributes),
      base,
    );
  }
  const stagedRow = row;
  try {
    const ryze = await (deps.makeClient ?? clientFor)(staged.gw);
    const sent = await send(ryze, staged.conv.chatJid);
    await landAndEcho(staged.gw, stagedRow, sent.messageId, base);
    return { messageId: sent.messageId, conversationId: staged.conv.displayId };
  } catch (err) {
    await scoped(
      tenantId,
      (db) => db.ryzeMessage.delete({ where: { id: stagedRow.id } }),
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
  validateConversationContext(card);
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
    card,
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
  validateConversationContext(msg);
  return sendAsAgent(
    ctx,
    gatewayInstanceId,
    msg.to,
    msg.text,
    {},
    (ryze, chatJid) => ryze.sendText(chatJid, msg.text),
    msg,
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
  const bridge = bridgeFor(tap.reply);
  if (!bridge) return;
  const { url, secret } = bridge;
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
