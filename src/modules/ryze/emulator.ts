import { randomBytes } from "node:crypto";
import type {
  PrismaClient,
  RyzeConversation,
  RyzeGateway,
  RyzeMessage,
} from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import type { ScopedDb } from "@/lib/tenancy";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  createRyzeClient,
  RyzeApiError,
  type RyzeClient,
  type RyzeMediaType,
} from "./client";
import {
  RYZE_EMULATED_ACCOUNT_ID,
  RYZE_OPERATOR_USER,
  ryzeEmulatorBaseUrl,
} from "./constants";
import { emitToBots } from "./emit";
import {
  presentContact,
  presentInbox,
  presentMessageRest,
  presentMessageWebhook,
  type StoredAttachment,
  storedAttachments,
} from "./present";
import {
  contactById,
  conversationBody,
  conversationByDisplayId,
  gatewayForInstance,
  listMessages,
  scoped,
  touchConversation,
} from "./store";

// An in-process Chatwoot for accounts of kind RYZE. `ChatwootClient` is constructed with this as its
// fetch, so every method it has keeps its own request/response contract while the state lives in our
// tables and customer-facing sends go out through RyzeAPI. Routes it does not serve answer 404, which
// is what the callers already read as "this Chatwoot does not have that".

export interface RyzeEmulatorDeps {
  base?: PrismaClient;
  makeRyzeClient?: (gw: RyzeGateway) => Promise<RyzeClient>;
}

interface Sender {
  type: "agent_bot" | "user";
  id: number;
  name: string;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NOT_FOUND = () => json(404, { error: "Resource could not be found" });

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fileTypeOf(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function ryzeMediaTypeOf(fileType: string): RyzeMediaType {
  if (fileType === "image" || fileType === "audio" || fileType === "video") {
    return fileType;
  }
  return "document";
}

async function defaultRyzeClient(gw: RyzeGateway): Promise<RyzeClient> {
  return createRyzeClient({
    baseUrl: gw.baseUrl,
    instance: gw.instanceName,
    token: decryptJson<string>(gw.token),
  });
}

let ryzeClientFactory: (gw: RyzeGateway) => Promise<RyzeClient> =
  defaultRyzeClient;

// NOTE: test seam for the emulators built by `loadChatwootClient`; returns the previous factory.
export function setRyzeClientFactory(
  next: (gw: RyzeGateway) => Promise<RyzeClient>,
): (gw: RyzeGateway) => Promise<RyzeClient> {
  const prev = ryzeClientFactory;
  ryzeClientFactory = next;
  return prev;
}

function sendFailureStatus(err: unknown): number {
  return err instanceof RyzeApiError && err.status >= 400 && err.status < 500
    ? 422
    : 503;
}

export class RyzeEmulator {
  private readonly base: PrismaClient;
  private readonly makeRyze: (gw: RyzeGateway) => Promise<RyzeClient>;
  private readonly root: string;

  constructor(
    private readonly tenantId: bigint,
    private readonly instanceId: bigint,
    deps: RyzeEmulatorDeps = {},
  ) {
    this.base = deps.base ?? basePrisma;
    this.makeRyze = deps.makeRyzeClient ?? ((gw) => ryzeClientFactory(gw));
    this.root = ryzeEmulatorBaseUrl(instanceId);
  }

  get baseUrl(): string {
    return this.root;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    try {
      return await this.route(method, url, headers, init.body ?? null);
    } catch (err) {
      logger.error(
        "ryze emulator: %s %s failed: %s",
        method,
        url.pathname,
        err instanceof Error ? err.message : String(err),
      );
      return json(500, { error: "emulator failure" });
    }
  };

  private db<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
    return scoped(this.tenantId, fn, this.base);
  }

  private async gateway(): Promise<RyzeGateway> {
    const gw = await this.db((db) => gatewayForInstance(db, this.instanceId));
    if (!gw) throw new Error("ryze gateway not found for instance");
    return gw;
  }

  private emit(gw: RyzeGateway, payloads: unknown[]): void {
    emitToBots(
      { tenantId: this.tenantId, gatewayId: gw.id, base: this.base },
      payloads,
    );
  }

  private async senderFor(
    gw: RyzeGateway,
    token: string | null,
  ): Promise<Sender> {
    if (token) {
      const bots = await this.db((db) =>
        db.ryzeBot.findMany({
          where: { gatewayId: gw.id },
          select: { botId: true, name: true, accessToken: true },
        }),
      );
      const bot = bots.find(
        (b) => decryptJson<string>(b.accessToken) === token,
      );
      if (bot) return { type: "agent_bot", id: bot.botId, name: bot.name };
    }
    return { type: "user", ...RYZE_OPERATOR_USER };
  }

  private async route(
    method: string,
    url: URL,
    headers: Headers,
    body: BodyInit | null,
  ): Promise<Response> {
    const rootPath = new URL(this.root).pathname;
    if (!url.pathname.startsWith(rootPath)) return NOT_FOUND();
    const rest = url.pathname.slice(rootPath.length);

    const media = /^\/media\/(\d+)$/.exec(rest);
    if (media && method === "GET") return this.getMedia(Number(media[1]));

    if (rest === "/api/v1/profile" && method === "GET") {
      const gw = await this.gateway();
      return json(200, {
        accounts: [
          {
            id: RYZE_EMULATED_ACCOUNT_ID,
            name: gw.inboxName,
            role: "administrator",
          },
        ],
      });
    }
    const acct = /^\/api\/v1\/accounts\/\d+/.exec(rest);
    if (!acct) return NOT_FOUND();
    const path = rest.slice(acct[0].length);
    const q = url.searchParams;
    const token = headers.get(CHATWOOT_AUTH_HEADER);
    const readJson = async (): Promise<Record<string, unknown>> => {
      if (typeof body !== "string" || body === "") return {};
      const parsed = JSON.parse(body) as unknown;
      return isRecord(parsed) ? parsed : {};
    };

    let m: RegExpExecArray | null;
    if (path === "" && method === "GET") {
      const gw = await this.gateway();
      return json(200, { id: RYZE_EMULATED_ACCOUNT_ID, name: gw.inboxName });
    }

    m = /^\/conversations\/(\d+)\/messages$/.exec(path);
    if (m) {
      const cid = Number(m[1]);
      if (method === "GET") return this.getMessages(cid, q);
      if (method === "POST") {
        return body instanceof FormData
          ? this.postMultipart(cid, body, token)
          : this.postMessage(cid, await readJson(), token);
      }
    }
    m = /^\/conversations\/(\d+)\/messages\/(\d+)\/attachments\/(\d+)$/.exec(
      path,
    );
    if (m && method === "PATCH") {
      return this.patchAttachment(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        await readJson(),
      );
    }
    m = /^\/conversations\/(\d+)\/messages\/(\d+)\/reactions$/.exec(path);
    if (m && method === "POST") {
      return this.react(Number(m[1]), Number(m[2]), await readJson(), token);
    }
    m = /^\/conversations\/(\d+)$/.exec(path);
    if (m && method === "GET") return this.getConversation(Number(m[1]));
    m = /^\/conversations\/(\d+)\/toggle_status$/.exec(path);
    if (m && method === "POST")
      return this.toggleStatus(Number(m[1]), await readJson());
    m = /^\/conversations\/(\d+)\/assignments$/.exec(path);
    if (m && method === "POST")
      return this.assign(Number(m[1]), await readJson());
    m = /^\/conversations\/(\d+)\/custom_attributes$/.exec(path);
    if (m && method === "POST")
      return this.setConvAttributes(Number(m[1]), await readJson());
    m = /^\/conversations\/(\d+)\/labels$/.exec(path);
    if (m && method === "GET") return this.getConvLabels(Number(m[1]));
    if (m && method === "POST")
      return this.setConvLabels(Number(m[1]), await readJson());
    m = /^\/conversations\/(\d+)\/toggle_typing_status$/.exec(path);
    if (m && method === "POST")
      return this.typing(Number(m[1]), await readJson());
    m = /^\/conversations\/(\d+)\/read_receipt$/.exec(path);
    if (m && method === "POST")
      return this.readReceipt(Number(m[1]), await readJson());
    if (path === "/conversations" && method === "POST") {
      return this.createConversation(await readJson());
    }

    m = /^\/contacts\/(\d+)$/.exec(path);
    if (m && method === "GET") return this.getContact(Number(m[1]));
    if (m && method === "PUT")
      return this.putContact(Number(m[1]), await readJson());
    m = /^\/contacts\/(\d+)\/labels$/.exec(path);
    if (m && method === "GET") return this.getContactLabels(Number(m[1]));
    if (m && method === "POST")
      return this.setContactLabels(Number(m[1]), await readJson());
    m = /^\/contacts\/(\d+)\/conversations$/.exec(path);
    if (m && method === "GET") return this.contactConversations(Number(m[1]));
    if (path === "/contacts/search" && method === "GET") {
      return this.searchContacts(
        q.get("q") ?? "",
        Number(q.get("page") ?? "1"),
      );
    }

    if (path === "/labels" && method === "GET") return this.accountLabels();
    if (path === "/custom_attribute_definitions" && method === "GET")
      return json(200, []);
    if (path === "/agents" && method === "GET") return json(200, []);
    if (path === "/teams" && method === "GET") return json(200, []);

    if (path === "/inboxes" && method === "GET") {
      const gw = await this.gateway();
      return json(200, { payload: [presentInbox(gw)] });
    }
    m = /^\/inboxes\/(\d+)$/.exec(path);
    if (m && method === "GET") {
      const gw = await this.gateway();
      return Number(m[1]) === gw.inboxId
        ? json(200, presentInbox(gw))
        : NOT_FOUND();
    }
    m = /^\/inboxes\/(\d+)\/agent_bot$/.exec(path);
    if (m && method === "GET") return this.inboxBot(Number(m[1]));
    m = /^\/inboxes\/(\d+)\/set_agent_bot$/.exec(path);
    if (m && method === "POST")
      return this.setInboxBot(Number(m[1]), await readJson());
    m = /^\/inboxes\/(\d+)\/agent_bot_observers$/.exec(path);
    if (m && method === "POST")
      return this.addObserver(Number(m[1]), await readJson());
    m = /^\/inboxes\/(\d+)\/agent_bot_observers\/(\d+)$/.exec(path);
    if (m && method === "DELETE")
      return this.removeObserver(Number(m[1]), Number(m[2]));

    if (path === "/agent_bots" && method === "POST")
      return this.createBot(await readJson());
    if (path === "/agent_bots" && method === "GET") return this.listBots();
    m = /^\/agent_bots\/(\d+)$/.exec(path);
    if (m && method === "PATCH")
      return this.renameBot(Number(m[1]), await readJson());

    return NOT_FOUND();
  }

  // ── messages ──

  private async getMessages(
    cid: number,
    q: URLSearchParams,
  ): Promise<Response> {
    const gw = await this.gateway();
    const before = q.has("before") ? Number(q.get("before")) : undefined;
    const after = q.has("after") ? Number(q.get("after")) : undefined;
    const rows = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, cid);
      if (!conv) return null;
      return listMessages(db, gw.id, cid, { before, after });
    });
    if (!rows) return NOT_FOUND();
    return json(200, { meta: {}, payload: rows.map(presentMessageRest) });
  }

  private async insertOutgoing(
    gw: RyzeGateway,
    conv: RyzeConversation,
    p: {
      content: string | null;
      isPrivate: boolean;
      messageType: number;
      contentAttributes: Record<string, unknown>;
      attachments: StoredAttachment[];
      sender: Sender;
      status: string;
    },
  ): Promise<RyzeMessage> {
    return this.db((db) =>
      db.ryzeMessage.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          conversationId: conv.displayId,
          messageType: p.messageType,
          private: p.isPrivate,
          content: p.content,
          contentAttributes: p.contentAttributes as object,
          attachments: p.attachments as unknown as object,
          senderType: p.sender.type,
          senderId: p.sender.id,
          senderName: p.sender.name,
          status: p.status,
        },
      }),
    );
  }

  private async landed(
    gw: RyzeGateway,
    msg: RyzeMessage,
    externalId: string | null,
  ): Promise<RyzeMessage> {
    return this.db(async (db) => {
      const updated = await db.ryzeMessage.update({
        where: { id: msg.id },
        data: { externalId, status: "sent" },
      });
      const conv = await conversationByDisplayId(db, gw.id, msg.conversationId);
      if (conv) await touchConversation(db, conv);
      return updated;
    });
  }

  private async echo(gw: RyzeGateway, msg: RyzeMessage): Promise<void> {
    const body = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, msg.conversationId);
      return conv ? conversationBody(db, gw, conv) : null;
    });
    if (body) {
      this.emit(gw, [presentMessageWebhook("message_created", msg, body, gw)]);
    }
  }

  private async postMessage(
    cid: number,
    b: Record<string, unknown>,
    token: string | null,
  ): Promise<Response> {
    const gw = await this.gateway();
    const conv = await this.db((db) => conversationByDisplayId(db, gw.id, cid));
    if (!conv) return NOT_FOUND();
    const sender = await this.senderFor(gw, token);
    const isPrivate = b.private === true;
    const content = typeof b.content === "string" ? b.content : null;
    const messageType =
      b.message_type === "incoming" ? 0 : b.message_type === "activity" ? 2 : 1;
    const goesOut = !isPrivate && messageType === 1 && !!content;
    const row = await this.insertOutgoing(gw, conv, {
      content,
      isPrivate,
      messageType,
      contentAttributes: isRecord(b.content_attributes)
        ? b.content_attributes
        : {},
      attachments: [],
      sender,
      status: goesOut ? "sending" : "sent",
    });
    if (!goesOut) {
      await this.echo(gw, row);
      return json(200, presentMessageRest(row));
    }
    try {
      const ryze = await this.makeRyze(gw);
      const sent = await ryze.sendText(conv.chatJid, content as string);
      const done = await this.landed(gw, row, sent.messageId);
      await this.echo(gw, done);
      return json(200, presentMessageRest(done));
    } catch (err) {
      await this.db((db) => db.ryzeMessage.delete({ where: { id: row.id } }));
      logger.warn(
        "ryze emulator: send failed on conversation %d: %s",
        cid,
        err instanceof Error ? err.message : String(err),
      );
      return json(sendFailureStatus(err), { error: "send failed" });
    }
  }

  private async postMultipart(
    cid: number,
    form: FormData,
    token: string | null,
  ): Promise<Response> {
    const gw = await this.gateway();
    const conv = await this.db((db) => conversationByDisplayId(db, gw.id, cid));
    if (!conv) return NOT_FOUND();
    const file = form.get("attachments[]");
    if (!(file instanceof File))
      return json(422, { error: "attachment missing" });
    const sender = await this.senderFor(gw, token);
    const bytes = await file.arrayBuffer();
    const mime = file.type || "application/octet-stream";
    const fileType = fileTypeOf(mime);
    const recorded = (() => {
      const raw = form.get("is_recorded_audio");
      try {
        const list =
          typeof raw === "string" ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(list) && list.includes(file.name);
      } catch {
        return false;
      }
    })();
    const transcribed = form.get(
      `attachments_metadata[${file.name}][transcribed_text]`,
    );
    const caption = form.get("content");
    const attrsRaw = form.get("content_attributes");
    let contentAttributes: Record<string, unknown> = {};
    try {
      const parsed =
        typeof attrsRaw === "string" ? (JSON.parse(attrsRaw) as unknown) : {};
      if (isRecord(parsed)) contentAttributes = parsed;
    } catch {
      contentAttributes = {};
    }

    const mediaRow = await this.db((db) =>
      db.ryzeMedia.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          messageId: 0,
          fileType,
          mime,
          fileName: file.name,
          bytes: Buffer.from(bytes),
        },
      }),
    );
    const attachment: StoredAttachment = {
      id: mediaRow.attachmentId,
      file_type: fileType,
      data_url: `${this.root}/media/${mediaRow.attachmentId}`,
      file_name: file.name,
      meta:
        typeof transcribed === "string"
          ? { transcribed_text: transcribed }
          : {},
    };
    const row = await this.insertOutgoing(gw, conv, {
      content: typeof caption === "string" ? caption : null,
      isPrivate: false,
      messageType: 1,
      contentAttributes,
      attachments: [attachment],
      sender,
      status: "sending",
    });
    await this.db((db) =>
      db.ryzeMedia.update({
        where: { id: mediaRow.id },
        data: { messageId: row.messageId },
      }),
    );
    try {
      const ryze = await this.makeRyze(gw);
      const sent = await ryze.sendMedia(conv.chatJid, {
        type: ryzeMediaTypeOf(fileType),
        bytes,
        mime,
        fileName: file.name,
        caption: typeof caption === "string" ? caption : undefined,
        isVoice: recorded,
      });
      const done = await this.landed(gw, row, sent.messageId);
      await this.echo(gw, done);
      return json(200, presentMessageRest(done));
    } catch (err) {
      await this.db(async (db) => {
        await db.ryzeMessage.delete({ where: { id: row.id } });
        await db.ryzeMedia.delete({ where: { id: mediaRow.id } });
      });
      logger.warn(
        "ryze emulator: media send failed on conversation %d: %s",
        cid,
        err instanceof Error ? err.message : String(err),
      );
      return json(sendFailureStatus(err), { error: "send failed" });
    }
  }

  private async patchAttachment(
    cid: number,
    mid: number,
    aid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const ok = await this.db(async (db) => {
      const msg = await db.ryzeMessage.findUnique({
        where: { messageId: mid },
      });
      if (!msg || msg.gatewayId !== gw.id || msg.conversationId !== cid)
        return false;
      const list = storedAttachments(msg);
      const idx = list.findIndex((a) => a.id === aid);
      if (idx < 0) return false;
      const current = list[idx] as StoredAttachment;
      list[idx] = { ...current, meta: isRecord(b.meta) ? b.meta : {} };
      await db.ryzeMessage.update({
        where: { id: msg.id },
        data: { attachments: list as unknown as object },
      });
      return true;
    });
    return ok ? json(200, {}) : NOT_FOUND();
  }

  private async react(
    cid: number,
    mid: number,
    b: Record<string, unknown>,
    token: string | null,
  ): Promise<Response> {
    const gw = await this.gateway();
    const emoji = typeof b.emoji === "string" ? b.emoji : "";
    const found = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, cid);
      const target = await db.ryzeMessage.findUnique({
        where: { messageId: mid },
      });
      if (
        !conv ||
        !target ||
        target.gatewayId !== gw.id ||
        !target.externalId
      ) {
        return null;
      }
      const prior = await db.ryzeMessage.findFirst({
        where: {
          gatewayId: gw.id,
          conversationId: cid,
          messageType: 1,
          contentAttributes: { path: ["in_reply_to"], equals: mid },
        },
        orderBy: { messageId: "desc" },
      });
      return { conv, target, prior };
    });
    if (!found) return NOT_FOUND();
    const priorIsSame =
      found.prior &&
      isRecord(found.prior.contentAttributes) &&
      found.prior.contentAttributes.is_reaction === true &&
      found.prior.content === emoji;
    const toSend = priorIsSame ? "" : emoji;
    try {
      const ryze = await this.makeRyze(gw);
      await ryze.sendReaction(
        found.conv.chatJid,
        found.target.externalId as string,
        toSend,
      );
    } catch (err) {
      return json(sendFailureStatus(err), { error: "reaction failed" });
    }
    const sender = await this.senderFor(gw, token);
    await this.db(async (db) => {
      if (found.prior && priorIsSame) {
        await db.ryzeMessage.delete({ where: { id: found.prior.id } });
        return;
      }
      await db.ryzeMessage.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          conversationId: cid,
          messageType: 1,
          content: emoji,
          contentAttributes: { is_reaction: true, in_reply_to: mid },
          senderType: sender.type,
          senderId: sender.id,
          senderName: sender.name,
        },
      });
    });
    return json(200, {});
  }

  private async getMedia(attachmentId: number): Promise<Response> {
    const gw = await this.gateway();
    const media = await this.db((db) =>
      db.ryzeMedia.findUnique({ where: { attachmentId } }),
    );
    if (!media || media.gatewayId !== gw.id) return NOT_FOUND();
    let bytes = media.bytes ? new Uint8Array(media.bytes) : null;
    let mime = media.mime;
    if (!bytes && media.externalMessageId) {
      try {
        const ryze = await this.makeRyze(gw);
        const got = await ryze.downloadMedia(media.externalMessageId);
        bytes = new Uint8Array(got.bytes);
        mime = got.mime ?? mime;
        await this.db((db) =>
          db.ryzeMedia.update({
            where: { id: media.id },
            data: { bytes: Buffer.from(bytes as Uint8Array), mime },
          }),
        );
      } catch {
        return NOT_FOUND();
      }
    }
    if (!bytes) return NOT_FOUND();
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": mime ?? "application/octet-stream" },
    });
  }

  // ── conversations ──

  private async getConversation(cid: number): Promise<Response> {
    const gw = await this.gateway();
    const body = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, cid);
      return conv ? conversationBody(db, gw, conv) : null;
    });
    return body ? json(200, body) : NOT_FOUND();
  }

  private async mutateConversation(
    cid: number,
    change: (conv: RyzeConversation) => Record<string, unknown> | null,
    events: (before: RyzeConversation, after: RyzeConversation) => string[],
  ): Promise<{ conv: RyzeConversation } | null> {
    const gw = await this.gateway();
    const out = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, cid);
      if (!conv) return null;
      const data = change(conv);
      const after = data
        ? await db.ryzeConversation.update({ where: { id: conv.id }, data })
        : conv;
      const body = await conversationBody(db, gw, after);
      return { before: conv, after, body };
    });
    if (!out) return null;
    const names = events(out.before, out.after);
    this.emit(
      gw,
      names.map((event) => ({ ...out.body, event })),
    );
    return { conv: out.after };
  }

  private async toggleStatus(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const status = typeof b.status === "string" ? b.status : "";
    if (!["open", "pending", "resolved", "snoozed"].includes(status)) {
      return json(422, { error: "invalid status" });
    }
    const done = await this.mutateConversation(
      cid,
      (c) => (c.status === status ? null : { status }),
      (before, after) => {
        if (before.status === after.status) return [];
        const extra =
          after.status === "resolved"
            ? ["conversation_resolved"]
            : after.status === "open"
              ? ["conversation_opened"]
              : [];
        return [
          "conversation_status_changed",
          ...extra,
          "conversation_updated",
        ];
      },
    );
    if (!done) return NOT_FOUND();
    return json(200, {
      success: true,
      conversation_id: cid,
      current_status: done.conv.status,
    });
  }

  private async assign(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const assigneeId = num(b.assignee_id);
    const teamId = num(b.team_id);
    const done = await this.mutateConversation(
      cid,
      () => {
        if (teamId !== null) return { teamId: teamId > 0 ? teamId : null };
        if (assigneeId === null) return null;
        return assigneeId > 0
          ? { assigneeType: "User", assigneeId, assigneeName: "" }
          : { assigneeType: null, assigneeId: null, assigneeName: null };
      },
      (before, after) =>
        before.assigneeId !== after.assigneeId || before.teamId !== after.teamId
          ? ["conversation_updated"]
          : [],
    );
    return done ? json(200, {}) : NOT_FOUND();
  }

  private async setConvAttributes(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const attrs = isRecord(b.custom_attributes) ? b.custom_attributes : {};
    const done = await this.mutateConversation(
      cid,
      () => ({ customAttributes: attrs as object }),
      () => ["conversation_updated"],
    );
    return done ? json(200, { custom_attributes: attrs }) : NOT_FOUND();
  }

  private async getConvLabels(cid: number): Promise<Response> {
    const gw = await this.gateway();
    const conv = await this.db((db) => conversationByDisplayId(db, gw.id, cid));
    return conv ? json(200, { payload: conv.labels }) : NOT_FOUND();
  }

  private async setConvLabels(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const labels = Array.isArray(b.labels)
      ? b.labels.filter((l): l is string => typeof l === "string")
      : [];
    const done = await this.mutateConversation(
      cid,
      () => ({ labels }),
      () => ["conversation_updated"],
    );
    return done ? json(200, { payload: labels }) : NOT_FOUND();
  }

  private async typing(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const conv = await this.db((db) => conversationByDisplayId(db, gw.id, cid));
    if (!conv) return NOT_FOUND();
    try {
      const ryze = await this.makeRyze(gw);
      await ryze.setPresence(conv.chatJid, b.typing_status === "on");
    } catch {
      return json(502, { error: "presence failed" });
    }
    return json(200, {});
  }

  private async readReceipt(
    cid: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const ids = Array.isArray(b.message_ids)
      ? b.message_ids.map(num).filter((n): n is number => n !== null)
      : [];
    const target = await this.db(async (db) => {
      const conv = await conversationByDisplayId(db, gw.id, cid);
      if (!conv) return null;
      const msg = await db.ryzeMessage.findFirst({
        where: {
          gatewayId: gw.id,
          conversationId: cid,
          messageType: 0,
          externalId: { not: null },
          ...(ids.length > 0 ? { messageId: { in: ids } } : {}),
        },
        orderBy: { messageId: "desc" },
      });
      return msg ? { conv, msg } : null;
    });
    if (!target) return NOT_FOUND();
    try {
      const ryze = await this.makeRyze(gw);
      await ryze.markRead(target.conv.chatJid, target.msg.externalId as string);
    } catch {
      return json(502, { error: "read receipt failed" });
    }
    return json(200, {});
  }

  private async createConversation(
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const contactId = num(b.contact_id);
    if (contactId === null) return json(422, { error: "contact_id required" });
    const body = await this.db(async (db) => {
      const contact = await contactById(db, gw.id, contactId);
      if (!contact) return null;
      const existing = await db.ryzeConversation.findUnique({
        where: {
          gatewayId_chatJid: { gatewayId: gw.id, chatJid: contact.jid },
        },
      });
      const conv =
        existing ??
        (await db.ryzeConversation.create({
          data: {
            tenantId: gw.tenantId,
            gatewayId: gw.id,
            contactId,
            chatJid: contact.jid,
            status: typeof b.status === "string" ? b.status : "pending",
            customAttributes: (isRecord(b.custom_attributes)
              ? b.custom_attributes
              : {}) as object,
          },
        }));
      return conversationBody(db, gw, conv);
    });
    return body ? json(200, body) : NOT_FOUND();
  }

  // ── contacts ──

  private async getContact(id: number): Promise<Response> {
    const gw = await this.gateway();
    const c = await this.db((db) => contactById(db, gw.id, id));
    return c ? json(200, { payload: presentContact(c) }) : NOT_FOUND();
  }

  private async putContact(
    id: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const data: Record<string, unknown> = {};
    if (isRecord(b.custom_attributes))
      data.customAttributes = b.custom_attributes;
    for (const [key, field] of [
      ["name", "name"],
      ["email", "email"],
      ["phone_number", "phone"],
      ["identifier", "identifier"],
    ] as const) {
      if (key in b) {
        const v = b[key];
        data[field] = typeof v === "string" && v !== "" ? v : null;
      }
    }
    const c = await this.db(async (db) => {
      const found = await contactById(db, gw.id, id);
      return found
        ? db.ryzeContact.update({ where: { id: found.id }, data })
        : null;
    });
    return c ? json(200, { payload: presentContact(c) }) : NOT_FOUND();
  }

  private async getContactLabels(id: number): Promise<Response> {
    const gw = await this.gateway();
    const c = await this.db((db) => contactById(db, gw.id, id));
    return c ? json(200, { payload: c.labels }) : NOT_FOUND();
  }

  private async setContactLabels(
    id: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const labels = Array.isArray(b.labels)
      ? b.labels.filter((l): l is string => typeof l === "string")
      : [];
    const c = await this.db(async (db) => {
      const found = await contactById(db, gw.id, id);
      return found
        ? db.ryzeContact.update({ where: { id: found.id }, data: { labels } })
        : null;
    });
    return c ? json(200, { payload: labels }) : NOT_FOUND();
  }

  private async contactConversations(id: number): Promise<Response> {
    const gw = await this.gateway();
    const list = await this.db((db) =>
      db.ryzeConversation.findMany({
        where: { gatewayId: gw.id, contactId: id },
        orderBy: { displayId: "desc" },
      }),
    );
    return json(200, {
      payload: list.map((c) => ({
        id: c.displayId,
        inbox_id: gw.inboxId,
        status: c.status,
        can_reply: true,
      })),
    });
  }

  private async searchContacts(q: string, page: number): Promise<Response> {
    const gw = await this.gateway();
    const term = q.trim();
    const skip = (Math.max(1, page) - 1) * 15;
    const list = term
      ? await this.db((db) =>
          db.ryzeContact.findMany({
            where: {
              gatewayId: gw.id,
              OR: [
                { name: { contains: term, mode: "insensitive" } },
                { email: { equals: term, mode: "insensitive" } },
                { phone: { contains: term } },
                { identifier: { equals: term } },
                { jid: { contains: term } },
              ],
            },
            orderBy: { contactId: "asc" },
            skip,
            take: 15,
          }),
        )
      : [];
    return json(200, { payload: list.map(presentContact) });
  }

  private async accountLabels(): Promise<Response> {
    const gw = await this.gateway();
    const used = await this.db(async (db) => {
      const convs = await db.ryzeConversation.findMany({
        where: { gatewayId: gw.id },
        select: { labels: true },
      });
      const contacts = await db.ryzeContact.findMany({
        where: { gatewayId: gw.id },
        select: { labels: true },
      });
      return [...convs, ...contacts].flatMap((r) => r.labels);
    });
    const titles = [...new Set(used)].sort();
    return json(200, {
      payload: titles.map((title) => ({ title, color: "#1f93ff" })),
    });
  }

  // ── inbox + agent bots ──

  private async inboxBot(inboxId: number): Promise<Response> {
    const gw = await this.gateway();
    if (inboxId !== gw.inboxId) return NOT_FOUND();
    if (gw.agentBotId === null) return json(200, { agent_bot: {} });
    const bot = await this.db((db) =>
      db.ryzeBot.findUnique({ where: { botId: gw.agentBotId as number } }),
    );
    return json(200, {
      agent_bot: bot
        ? { id: bot.botId, name: bot.name, outgoing_url: bot.outgoingUrl }
        : {},
    });
  }

  private async setInboxBot(
    inboxId: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    if (inboxId !== gw.inboxId) return NOT_FOUND();
    const botId = num(b.agent_bot);
    await this.db((db) =>
      db.ryzeGateway.update({
        where: { id: gw.id },
        data: { agentBotId: botId },
      }),
    );
    return json(200, {});
  }

  private async addObserver(
    inboxId: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const botId = num(b.agent_bot);
    if (inboxId !== gw.inboxId || botId === null) return NOT_FOUND();
    if (!gw.observerBotIds.includes(botId)) {
      await this.db((db) =>
        db.ryzeGateway.update({
          where: { id: gw.id },
          data: { observerBotIds: [...gw.observerBotIds, botId] },
        }),
      );
    }
    return json(200, {});
  }

  private async removeObserver(
    inboxId: number,
    botId: number,
  ): Promise<Response> {
    const gw = await this.gateway();
    if (inboxId !== gw.inboxId || !gw.observerBotIds.includes(botId))
      return NOT_FOUND();
    await this.db((db) =>
      db.ryzeGateway.update({
        where: { id: gw.id },
        data: {
          observerBotIds: gw.observerBotIds.filter((id) => id !== botId),
        },
      }),
    );
    return json(200, {});
  }

  private async createBot(b: Record<string, unknown>): Promise<Response> {
    const gw = await this.gateway();
    const accessToken = randomBytes(24).toString("base64url");
    const secret = randomBytes(32).toString("hex");
    const bot = await this.db((db) =>
      db.ryzeBot.create({
        data: {
          tenantId: gw.tenantId,
          gatewayId: gw.id,
          name: typeof b.name === "string" ? b.name : "bot",
          outgoingUrl:
            typeof b.outgoing_url === "string" ? b.outgoing_url : null,
          accessToken: encryptJson(accessToken),
          secret: encryptJson(secret),
        },
      }),
    );
    return json(200, {
      id: bot.botId,
      name: bot.name,
      outgoing_url: bot.outgoingUrl,
      access_token: accessToken,
      secret,
    });
  }

  private async listBots(): Promise<Response> {
    const gw = await this.gateway();
    const bots = await this.db((db) =>
      db.ryzeBot.findMany({
        where: { gatewayId: gw.id },
        orderBy: { botId: "asc" },
      }),
    );
    return json(
      200,
      bots.map((bot) => ({ id: bot.botId, name: bot.name })),
    );
  }

  private async renameBot(
    botId: number,
    b: Record<string, unknown>,
  ): Promise<Response> {
    const gw = await this.gateway();
    const name = typeof b.name === "string" ? b.name : null;
    const bot = await this.db(async (db) => {
      const found = await db.ryzeBot.findUnique({ where: { botId } });
      if (!found || found.gatewayId !== gw.id) return null;
      return name
        ? db.ryzeBot.update({ where: { id: found.id }, data: { name } })
        : found;
    });
    return bot ? json(200, { id: bot.botId, name: bot.name }) : NOT_FOUND();
  }
}
