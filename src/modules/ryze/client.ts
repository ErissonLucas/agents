import { assertSafeOutboundUrl } from "@/lib/ssrf";

// RyzeAPI (a whatsmeow-based WhatsApp REST gateway) client. Every call carries the instance token in
// the `token` header; the instance name is the last path segment. Responses share the envelope
// `{success, message?, status?, data?, error?:{message}}` and the HTTP status is the source of truth.
// The gateway echoes our own sends back through the webhook with the `source` we set, which is how
// the receiver tells the bot's messages apart from a person typing on the phone.

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export const RYZE_SOURCE = "fazer-ai-agents";

export class RyzeApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly detail: string | null;
  constructor(status: number, endpoint: string, detail: string | null = null) {
    super(`RyzeAPI ${endpoint} failed with ${status}`);
    this.name = "RyzeApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

export interface RyzeClientConfig {
  baseUrl: string;
  instance: string;
  token: string;
}

export interface RyzeClientDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<void>;
}

export type RyzeMediaType = "image" | "video" | "document" | "audio";

export type RyzePresence = "typing" | "recording" | "pause";

export interface RyzeSentMessage {
  messageId: string | null;
  timestamp: string | null;
}

export interface RyzeConnectionState {
  state: string | null;
  numberJid: string | null;
  profileName: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// The recipient as the gateway wants it: a bare number for a phone JID, the JID untouched otherwise
// (`@lid`, `@g.us`), so a conversation keyed on a lid is answered on the lid it came from.
export function ryzeRecipient(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "");
}

export class RyzeClient {
  private readonly root: string;

  constructor(
    private readonly config: RyzeClientConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.root = config.baseUrl.replace(/\/+$/, "");
  }

  get instance(): string {
    return this.config.instance;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const endpoint = `${method} ${path.split("?")[0]}`;
    const res = await this.fetchImpl(`${this.root}${path}`, {
      method,
      headers: {
        token: this.config.token,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const obj = isRecord(parsed) ? parsed : {};
    if (!res.ok || obj.success === false) {
      const err = isRecord(obj.error) ? str(obj.error.message) : null;
      throw new RyzeApiError(res.ok ? 502 : res.status, endpoint, err);
    }
    return obj;
  }

  private path(prefix: string): string {
    return `${prefix}/${encodeURIComponent(this.config.instance)}`;
  }

  private static sent(res: Record<string, unknown>): RyzeSentMessage {
    const data = isRecord(res.data) ? res.data : {};
    return {
      messageId: str(data.messageId),
      timestamp: str(data.timestamp),
    };
  }

  async sendText(
    jid: string,
    message: string,
    opts: { replyTo?: string } = {},
  ): Promise<RyzeSentMessage> {
    const res = await this.call("POST", this.path("/api/message/text"), {
      number: ryzeRecipient(jid),
      message,
      source: RYZE_SOURCE,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    return RyzeClient.sent(res);
  }

  async sendMedia(
    jid: string,
    media: {
      type: RyzeMediaType;
      bytes: ArrayBuffer;
      mime: string;
      fileName?: string;
      caption?: string;
      isVoice?: boolean;
    },
  ): Promise<RyzeSentMessage> {
    const res = await this.call("POST", this.path("/api/message/media"), {
      number: ryzeRecipient(jid),
      mediaType: media.type,
      mediaBase64: Buffer.from(media.bytes).toString("base64"),
      mimeType: media.mime,
      source: RYZE_SOURCE,
      ...(media.fileName ? { fileName: media.fileName } : {}),
      ...(media.caption ? { message: media.caption } : {}),
      ...(media.type === "audio" ? { isVoice: media.isVoice ?? false } : {}),
    });
    return RyzeClient.sent(res);
  }

  // NOTE: reply buttons only. RyzeAPI allows up to 3, and mixing REPLY with URL/CALL/COPY makes the
  // REPLY ones vanish on WhatsApp Web/Desktop, so this client never offers the other kinds.
  async sendButtons(
    jid: string,
    card: {
      text: string;
      header?: string;
      footer?: string;
      buttons: { id: string; title: string }[];
    },
  ): Promise<RyzeSentMessage> {
    const res = await this.call("POST", this.path("/api/message/button"), {
      number: ryzeRecipient(jid),
      contentText: card.text,
      ...(card.header ? { headerText: card.header } : {}),
      ...(card.footer ? { footerText: card.footer } : {}),
      buttons: card.buttons.map((b) => ({
        id: b.id,
        displayText: b.title,
        type: "REPLY",
      })),
      source: RYZE_SOURCE,
    });
    return RyzeClient.sent(res);
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<RyzeSentMessage> {
    const res = await this.call("POST", this.path("/api/message/reaction"), {
      number: ryzeRecipient(jid),
      messageId,
      reaction: emoji === "" ? "remove" : emoji,
      fromMe: false,
    });
    return RyzeClient.sent(res);
  }

  async setPresence(jid: string, state: RyzePresence): Promise<void> {
    await this.call("POST", this.path("/api/chat/presence"), {
      number: ryzeRecipient(jid),
      state,
      ...(state === "pause" ? {} : { duration: 20 }),
    });
  }

  async markRead(jid: string, messageId: string): Promise<void> {
    await this.call("POST", this.path("/api/chat/markRead"), {
      number: ryzeRecipient(jid),
      messageId,
    });
  }

  async downloadMedia(
    messageId: string,
  ): Promise<{ bytes: ArrayBuffer; mime: string | null }> {
    const res = await this.call(
      "GET",
      `${this.path("/api/chat/base64")}?messageId=${encodeURIComponent(messageId)}`,
    );
    const b64 = str(res.base64);
    if (!b64) throw new RyzeApiError(404, "GET /api/chat/base64");
    const buf = Buffer.from(b64, "base64");
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      throw new RyzeApiError(413, "GET /api/chat/base64");
    }
    return {
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mime: str(res.mime_type),
    };
  }

  async configureWebhook(params: {
    url: string;
    authorization: string;
    label?: string;
  }): Promise<void> {
    await this.call("POST", this.path("/api/events/webhook"), {
      label: params.label ?? "fazer-ai-agents",
      enabled: true,
      url: params.url,
      authorization: params.authorization,
      events: ["message.exchange", "instance.state"],
      mediaBase64: true,
    });
  }

  async disableWebhook(label = "fazer-ai-agents"): Promise<void> {
    await this.call("POST", this.path("/api/events/webhook"), {
      label,
      enabled: false,
    });
  }

  // Starts the WhatsApp login: a QR (PNG data URL) to scan, or with `number` an 8-character pairing
  // code to type in WhatsApp. Ryze holds the request until it has one (about a minute at most).
  async pair(
    number?: string,
  ): Promise<{ qrCodeBase64: string | null; pairingCode: string | null }> {
    const query = number ? `?number=${encodeURIComponent(number)}` : "";
    const res = await this.call(
      "GET",
      `${this.path("/api/instance/connect")}${query}`,
      undefined,
      70_000,
    );
    return {
      qrCodeBase64: str(res.qrCodeBase64),
      pairingCode: str(res.pairingCode),
    };
  }

  async connectionState(): Promise<RyzeConnectionState> {
    const res = await this.call(
      "GET",
      `/api/instance/list?instanceName=${encodeURIComponent(this.config.instance)}`,
    );
    const list = Array.isArray(res.instances) ? res.instances : [];
    const inst = list.find(
      (i) => isRecord(i) && i.name === this.config.instance,
    ) as Record<string, unknown> | undefined;
    const conn = inst && isRecord(inst.connection) ? inst.connection : {};
    const profile = inst && isRecord(inst.profile) ? inst.profile : {};
    return {
      state: str(conn.state) ?? (inst ? str(inst.status) : null),
      numberJid: str(conn.numberJid),
      profileName: str(profile.name),
    };
  }
}

// Validates the operator-configured base URL (anti-SSRF, https-only) before any call is possible.
export async function createRyzeClient(
  config: RyzeClientConfig,
  deps: RyzeClientDeps = {},
): Promise<RyzeClient> {
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(config.baseUrl);
  return new RyzeClient(config, deps.fetchImpl ?? fetch);
}
