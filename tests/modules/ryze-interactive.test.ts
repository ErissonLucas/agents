import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { RYZE_SOURCE, RyzeClient } from "@/modules/ryze/client";
import {
  bridgeClaims,
  buttonReplyOf,
  sendRyzeText,
  validateCard,
  validateText,
} from "@/modules/ryze/interactive";
import { exchangeMessage } from "@/modules/ryze/receiver";
import { brazilianNinthDigitVariant } from "@/modules/ryze/store";

// The RyzeAPI docs describe a button tap in two shapes that disagree and a list pick in a third;
// buttonReplyOf reads every one, keeps the id and never takes free text for an id.

describe("buttonReplyOf", () => {
  test("event-catalog shape: button_response.selected_button_id", () => {
    const r = buttonReplyOf({
      type: "text",
      button_response: { title: "Aprovar", selected_button_id: "maria:a:tok" },
      reply: { message_id: "CARD1" },
    });
    expect(r).toEqual({
      id: "maria:a:tok",
      title: "Aprovar",
      cardExternalId: "CARD1",
    });
  });

  test("send-buttons note shape: template_button_reply with the id in content", () => {
    const r = buttonReplyOf({
      type: "template_button_reply",
      content: { text: "maria:r:tok" },
      interactive: { selectedButtonId: "maria:r:tok" },
    });
    expect(r?.id).toBe("maria:r:tok");
  });

  test("list selection: list_response.single_select_reply.option_name", () => {
    const r = buttonReplyOf({
      list_response: {
        title: "Aprovar",
        single_select_reply: { option_name: "maria:a:x" },
      },
    });
    expect(r).toEqual({
      id: "maria:a:x",
      title: "Aprovar",
      cardExternalId: null,
    });
  });

  test("a plain text message is not a button reply", () => {
    expect(
      buttonReplyOf({ type: "text", content: { text: "maria:a:tok" } }),
    ).toBeNull();
  });

  test("an id with spaces or foreign characters is refused", () => {
    expect(
      buttonReplyOf({
        button_response: { selected_button_id: "aprovar tudo; drop" },
      }),
    ).toBeNull();
  });
});

describe("bridgeClaims", () => {
  const saved = { ...config.ryzeButtonBridge };
  const withBridge = (b: Partial<typeof saved>, fn: () => void) => {
    Object.assign(config.ryzeButtonBridge, b);
    try {
      fn();
    } finally {
      Object.assign(config.ryzeButtonBridge, saved);
    }
  };
  const tap = { id: "maria:a:tok", title: "Aprovar", cardExternalId: null };

  test("claims only ids with the prefix, when url and secret are set", () => {
    withBridge(
      { url: "https://api.example/b", secret: "s", prefix: "maria:" },
      () => {
        expect(bridgeClaims(tap)).toBe(true);
        expect(bridgeClaims({ ...tap, id: "outro:a" })).toBe(false);
      },
    );
  });

  test("off when any of url, secret or prefix is missing", () => {
    withBridge({ url: "", secret: "s", prefix: "maria:" }, () =>
      expect(bridgeClaims(tap)).toBe(false),
    );
    withBridge({ url: "https://x", secret: "", prefix: "maria:" }, () =>
      expect(bridgeClaims(tap)).toBe(false),
    );
    withBridge({ url: "https://x", secret: "s", prefix: "" }, () =>
      expect(bridgeClaims(tap)).toBe(false),
    );
  });
});

// Shapes captured from a live RyzeAPI WebSocket on 2026-09-28 (values replaced): chat, sender,
// direction and id sit on `data`, and the text is a plain string in `message.content`.
describe("the live message.exchange shape", () => {
  const liveTap = {
    id: "3EB0LIVETAPID0000000",
    direction: "incoming",
    timestamp: "2026-09-28T20:40:00-03:00",
    chat: {
      jid: "5581900000000@s.whatsapp.net",
      lid: "1@lid",
      name: "Contato",
      type: "private",
    },
    sender: {
      jid: "5581900000000@s.whatsapp.net",
      lid: "1@lid",
      name: "Contato",
    },
    recipient: null,
    message: {
      type: "buttons_response",
      content: "",
      source: "",
      isForwarded: false,
      isEdit: false,
      edit: null,
      context: null,
      media: null,
      reaction: null,
      interactive: { selectedButtonId: "maria:a:gXvXSwwuGzO1aVgxfIGktxHe" },
    },
  };

  test("the envelope fields are read from data, the message fields from data.message", () => {
    const msg = exchangeMessage(liveTap);
    expect(msg?.direction).toBe("incoming");
    expect(msg?.id).toBe("3EB0LIVETAPID0000000");
    expect((msg?.chat as Record<string, unknown> | undefined)?.type).toBe(
      "private",
    );
    expect(msg?.type).toBe("buttons_response");
    expect(msg?.edit ?? null).toBeNull(); // ausente: não é um card de edição
  });

  test("the tapped id is found on the live tap", () => {
    const msg = exchangeMessage(liveTap) as Record<string, unknown>;
    expect(buttonReplyOf(msg)?.id).toBe("maria:a:gXvXSwwuGzO1aVgxfIGktxHe");
  });

  test("an empty inner value does not hide the envelope's", () => {
    const msg = exchangeMessage({
      id: "OUTER",
      message: { id: "", type: "text", content: "oi" },
    });
    expect(msg?.id).toBe("OUTER");
    expect(msg?.content).toBe("oi");
  });

  test("the documented nested shape still reads the same", () => {
    const msg = exchangeMessage({
      id: "X",
      message: {
        id: "INNER",
        direction: "incoming",
        chat: { jid: "5581@s.whatsapp.net", type: "private" },
        content: { text: "oi" },
      },
    });
    expect(msg?.id).toBe("INNER");
    expect((msg?.content as Record<string, unknown> | undefined)?.text).toBe(
      "oi",
    );
  });
});

describe("brazilianNinthDigitVariant", () => {
  test("a mobile with the 9 maps to the short form and back", () => {
    expect(brazilianNinthDigitVariant("5581988236119@s.whatsapp.net")).toBe(
      "558188236119@s.whatsapp.net",
    );
    expect(brazilianNinthDigitVariant("558188236119@s.whatsapp.net")).toBe(
      "5581988236119@s.whatsapp.net",
    );
  });

  test("a landline, a foreign number and a lid have no variant", () => {
    expect(
      brazilianNinthDigitVariant("558133001234@s.whatsapp.net"),
    ).toBeNull();
    expect(brazilianNinthDigitVariant("14155550100@s.whatsapp.net")).toBeNull();
    expect(brazilianNinthDigitVariant("123456789012345@lid")).toBeNull();
  });
});

describe("sendRyzeText — validation", () => {
  const ok = { to: "5581988236119", text: "Olá" };

  test("a 10 to 15 digit recipient and a 1 to 4000 character text pass", () => {
    expect(() => validateText(ok)).not.toThrow();
    expect(() => validateText({ to: "5581988236", text: "x" })).not.toThrow();
    expect(() =>
      validateText({ to: "558198823611912", text: "x".repeat(4000) }),
    ).not.toThrow();
  });

  test("a short, long or non-digit recipient is refused", () => {
    for (const to of ["558198823", "5581988236119123", "+5581988236119"]) {
      expect(() => validateText({ ...ok, to })).toThrow(AppError);
    }
  });

  test("an empty, blank or too long text is refused", () => {
    for (const text of ["", "   ", "x".repeat(4001)]) {
      expect(() => validateText({ ...ok, text })).toThrow(AppError);
    }
  });

  test("the card keeps the same recipient and text rules", () => {
    const button = { id: "a", title: "Sim" };
    expect(() => validateCard({ ...ok, buttons: [button] })).not.toThrow();
    expect(() => validateCard({ ...ok, to: "123", buttons: [button] })).toThrow(
      AppError,
    );
  });

  test("link buttons take an https url and never mix with reply buttons", () => {
    const link = {
      url: "https://www.asaas.com/i/abc",
      title: "Pagar mensalidade",
    };
    expect(() => validateCard({ ...ok, buttons: [link] })).not.toThrow();
    expect(() =>
      validateCard({ ...ok, buttons: [link, { id: "a", title: "Sim" }] }),
    ).toThrow(AppError);
    for (const url of [
      "http://x.com/a",
      "javascript:alert(1)",
      "https://u:p@x.com/a",
    ]) {
      expect(() =>
        validateCard({ ...ok, buttons: [{ url, title: "Abrir" }] }),
      ).toThrow(AppError);
    }
    expect(() =>
      validateCard({
        ...ok,
        buttons: [{ id: "a", url: "https://x.com", title: "Dois" }],
      }),
    ).toThrow(AppError);
  });

  test("a card image must be an https URL without credentials", () => {
    const button = { id: "a", title: "Sim" };
    const card = { ...ok, buttons: [button] };
    expect(() =>
      validateCard({
        ...card,
        mediaUrl: "https://api.consultora.site/media/a.png",
      }),
    ).not.toThrow();
    for (const mediaUrl of [
      "http://x.com/a.png",
      "https://u:p@x.com/a.png",
      "nada",
      "ftp://x.com/a",
    ]) {
      expect(() => validateCard({ ...card, mediaUrl })).toThrow(AppError);
    }
  });

  test("an invalid message is refused before the database is touched", async () => {
    const touched: string[] = [];
    const base = new Proxy(
      {},
      {
        get(_t, key) {
          touched.push(String(key));
          throw new Error("database touched");
        },
      },
    ) as unknown as PrismaClient;
    const ctx = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" as const };
    await expect(
      sendRyzeText(ctx, 1n, { to: "123", text: "oi" }, { base }),
    ).rejects.toBeInstanceOf(AppError);
    expect(touched).toEqual([]);
  });
});

describe("RyzeClient.sendText — payload", () => {
  test("posts the bare number, the text and our source to the instance's text route", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ success: true, data: { messageId: "MSG1" } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new RyzeClient(
      { baseUrl: "https://ryze.example/", instance: "inst 1", token: "t" },
      fakeFetch,
    );
    const sent = await client.sendText("5581988236119@s.whatsapp.net", "Olá");
    expect(sent.messageId).toBe("MSG1");
    expect(calls).toEqual([
      {
        url: "https://ryze.example/api/message/text/inst%201",
        body: { number: "5581988236119", message: "Olá", source: RYZE_SOURCE },
      },
    ]);
  });
});
