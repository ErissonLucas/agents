import { describe, expect, test } from "bun:test";
import config from "@/config";
import { bridgeClaims, buttonReplyOf } from "@/modules/ryze/interactive";

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
