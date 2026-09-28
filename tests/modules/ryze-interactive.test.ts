import { describe, expect, test } from "bun:test";
import config from "@/config";
import { bridgeClaims, buttonReplyOf } from "@/modules/ryze/interactive";
import { exchangeMessage } from "@/modules/ryze/receiver";

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
