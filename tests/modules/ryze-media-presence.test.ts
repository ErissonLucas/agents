import { describe, expect, test } from "bun:test";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { RyzeClient } from "@/modules/ryze/client";
import { ryzePresenceOf } from "@/modules/ryze/emulator";
import { exchangeMessage, inboundMedia } from "@/modules/ryze/receiver";

// The attachment kind the Ryze receiver stores (which is what decides whether STT runs), and the
// presence seam from `toggleTyping` through the emulator's translation to RyzeAPI's payload.

// Shaped like the live message.exchange: chat/sender/direction/id on `data`, the message in
// `data.message`.
function liveEvent(media: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "3EB0LIVE",
    direction: "incoming",
    chat: { jid: "5581999990000@s.whatsapp.net", type: "private" },
    sender: { name: "Cliente" },
    timestamp: "2026-09-28T12:00:00Z",
    message: { type: "media", media },
  };
}

function kindOf(media: Record<string, unknown>): string | undefined {
  const msg = exchangeMessage(liveEvent(media));
  if (!msg) throw new Error("no message");
  return inboundMedia(msg)?.fileType;
}

describe("inboundMedia — file type", () => {
  test("a voice note with audio/mpeg and an unknown media.type is audio", () => {
    const msg = exchangeMessage(
      liveEvent({
        type: "AudioMessage",
        mimetype: "audio/mpeg",
        base64: Buffer.from("ID3").toString("base64"),
      }),
    );
    const media = msg ? inboundMedia(msg) : null;
    expect(media?.fileType).toBe("audio");
    expect(media?.mime).toBe("audio/mpeg");
    expect(media?.bytes?.byteLength).toBe(3);
  });

  test("audio/ogg under a value outside the known set is audio", () => {
    expect(kindOf({ type: "voice_note", mimetype: "audio/ogg" })).toBe("audio");
  });

  test("an opus PTT is audio, with the mime under mimeType", () => {
    expect(kindOf({ type: "ptt", mimeType: "audio/ogg; codecs=opus" })).toBe(
      "audio",
    );
  });

  test("the mime under `mime` is read too", () => {
    const msg = exchangeMessage(liveEvent({ mime: "image/jpeg" }));
    const media = msg ? inboundMedia(msg) : null;
    expect(media?.fileType).toBe("image");
    expect(media?.mime).toBe("image/jpeg");
  });

  test("image/jpeg is image, a sticker is image", () => {
    expect(kindOf({ type: "image", mimetype: "image/jpeg" })).toBe("image");
    expect(kindOf({ type: "sticker", mimetype: "image/webp" })).toBe("image");
    expect(kindOf({ type: "sticker" })).toBe("image");
  });

  test("video/mp4 is video", () => {
    expect(kindOf({ type: "whatever", mimetype: "video/mp4" })).toBe("video");
  });

  test("application/pdf and msword are a file (document)", () => {
    expect(kindOf({ type: "document", mimetype: "application/pdf" })).toBe(
      "file",
    );
    expect(kindOf({ mimetype: "application/msword" })).toBe("file");
  });

  test("the MIME wins over a type that disagrees", () => {
    expect(kindOf({ type: "document", mimetype: "audio/mpeg" })).toBe("audio");
    expect(kindOf({ type: "image", mimetype: "application/pdf" })).toBe("file");
  });

  test("with no MIME, or a generic one, a known type decides", () => {
    expect(kindOf({ type: "audio" })).toBe("audio");
    expect(kindOf({ type: "imageMessage" })).toBe("image");
    expect(kindOf({ type: "ptt", mimetype: "application/octet-stream" })).toBe(
      "audio",
    );
  });

  test("no type and no MIME is a file", () => {
    expect(kindOf({ fileName: "x.bin" })).toBe("file");
  });

  test("no media is no attachment", () => {
    const msg = exchangeMessage({
      id: "X",
      message: { type: "text", content: "oi" },
    });
    expect(msg ? inboundMedia(msg) : "none").toBeNull();
  });
});

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function fakeFetch(calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
    });
    return Response.json({ success: true });
  }) as typeof fetch;
}

function ryze(calls: Call[]): RyzeClient {
  return new RyzeClient(
    { baseUrl: "https://ryze.example.com", instance: "amanda", token: "tok" },
    fakeFetch(calls),
  );
}

describe("presence seam", () => {
  test("toggleTyping: on, off, and recording as on plus the hint", async () => {
    const calls: Call[] = [];
    const client = await createChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "A",
        botToken: "B",
      },
      { fetchImpl: fakeFetch(calls), assertSafe: async (u) => new URL(u) },
    );
    await client.toggleTyping(7, true);
    await client.toggleTyping(7, "recording");
    await client.toggleTyping(7, false);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/accounts/5/conversations/7/toggle_typing_status",
      "/api/v1/accounts/5/conversations/7/toggle_typing_status",
      "/api/v1/accounts/5/conversations/7/toggle_typing_status",
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { typing_status: "on" },
      { typing_status: "on", presence: "recording" },
      { typing_status: "off" },
    ]);
  });

  test("the emulator reads the body as RyzeAPI's state", () => {
    expect(ryzePresenceOf({ typing_status: "on" })).toBe("typing");
    expect(ryzePresenceOf({ typing_status: "on", presence: "recording" })).toBe(
      "recording",
    );
    expect(ryzePresenceOf({ typing_status: "off" })).toBe("pause");
    expect(ryzePresenceOf({ presence: "recording" })).toBe("pause");
    expect(ryzePresenceOf({})).toBe("pause");
  });

  test("RyzeClient.setPresence: typing and recording carry a duration, pause does not", async () => {
    const calls: Call[] = [];
    const c = ryze(calls);
    await c.setPresence("5581999990000@s.whatsapp.net", "typing");
    await c.setPresence("5581999990000@s.whatsapp.net", "recording");
    await c.setPresence("5581999990000@s.whatsapp.net", "pause");
    expect(calls.map((x) => x.path)).toEqual([
      "/api/chat/presence/amanda",
      "/api/chat/presence/amanda",
      "/api/chat/presence/amanda",
    ]);
    expect(calls.map((x) => x.body)).toEqual([
      { number: "5581999990000", state: "typing", duration: 20 },
      { number: "5581999990000", state: "recording", duration: 20 },
      { number: "5581999990000", state: "pause" },
    ]);
  });

  test("recording end to end: client body → emulator → RyzeAPI payload", async () => {
    const cw: Call[] = [];
    const client = await createChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "A",
        botToken: "B",
      },
      { fetchImpl: fakeFetch(cw), assertSafe: async (u) => new URL(u) },
    );
    await client.toggleTyping(7, "recording");
    const rz: Call[] = [];
    await ryze(rz).setPresence(
      "5581999990000@s.whatsapp.net",
      ryzePresenceOf(cw[0]?.body ?? {}),
    );
    expect(rz[0]?.body).toMatchObject({ state: "recording" });
  });
});
