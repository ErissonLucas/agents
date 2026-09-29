import { describe, expect, test } from "bun:test";
import { RyzeApiError, RyzeClient } from "@/modules/ryze/client";
import {
  chatNumber,
  labelDelta,
  labelSlug,
  RYZE_LABEL_COLORS,
  ryzeLabelColorHex,
  ryzeLabelPromptSection,
} from "@/modules/ryze/label-shared";
import { isLabelRefusal, labelsWorthTrying } from "@/modules/ryze/labels";

// The pure half of WhatsApp Business labels on RyzeAPI numbers, and the RyzeAPI label endpoints as
// the client calls them.

describe("labelDelta", () => {
  test("names what was added and what was removed, each once", () => {
    expect(labelDelta(["a", "b"], ["b", "c", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
    });
  });

  test("an unchanged list moves nothing", () => {
    expect(labelDelta(["a", "b"], ["b", "a"])).toEqual({
      added: [],
      removed: [],
    });
  });
});

describe("chatNumber", () => {
  test("the digits of a phone JID", () => {
    expect(chatNumber("5581999990000@s.whatsapp.net")).toBe("5581999990000");
  });

  test("a bare number is its own number", () => {
    expect(chatNumber("5581999990000")).toBe("5581999990000");
  });

  test("a group has no number", () => {
    expect(chatNumber("120363000000000000@g.us")).toBeNull();
  });

  test("a lid is not a phone number", () => {
    expect(chatNumber("123456789012345@lid")).toBeNull();
  });
});

describe("labelSlug", () => {
  test("lowercase, accents stripped, spaces as dashes", () => {
    expect(labelSlug("Proposta Enviada")).toBe("proposta-enviada");
    expect(labelSlug("  Não Interagiu  ")).toBe("nao-interagiu");
    expect(labelSlug("Follow-up 1")).toBe("follow-up-1");
  });

  test("drops what is not a letter, digit, dash or underscore", () => {
    expect(labelSlug("VIP ⭐ cliente!")).toBe("vip-cliente");
  });
});

describe("palette", () => {
  test("eleven WhatsApp colors, and an unknown index falls back to the first", () => {
    expect(RYZE_LABEL_COLORS).toHaveLength(11);
    expect(ryzeLabelColorHex(99)).toBe(RYZE_LABEL_COLORS[0] as string);
  });
});

describe("ryzeLabelPromptSection", () => {
  test("no block when no label says when to use it", () => {
    expect(
      ryzeLabelPromptSection([{ title: "lead-frio", description: null }], []),
    ).toBeNull();
  });

  test("lists described labels, the stage rule and the phone-edited titles", () => {
    const text = ryzeLabelPromptSection(
      [
        { title: "proposta-enviada", description: "Etapa: proposta enviada" },
        { title: "sem-descricao", description: "  " },
      ],
      ["vip"],
    ) as string;
    expect(text).toContain("- proposta-enviada: Etapa: proposta enviada");
    expect(text).not.toContain("sem-descricao");
    expect(text).toContain("set_labels");
    expect(text).toContain('"Etapa:"');
    expect(text).toContain("pelo celular: vip.");
  });
});

describe("label refusal and re-check", () => {
  test("a 4xx is a refusal, a 404 only when listing, a 5xx never", () => {
    expect(isLabelRefusal(new RyzeApiError(400, "POST /api/chat/tag"))).toBe(
      true,
    );
    expect(
      isLabelRefusal(new RyzeApiError(404, "POST /api/chat/assignTag")),
    ).toBe(false);
    expect(
      isLabelRefusal(new RyzeApiError(404, "GET /api/chat/tag"), true),
    ).toBe(true);
    expect(isLabelRefusal(new RyzeApiError(503, "GET /api/chat/tag"))).toBe(
      false,
    );
    expect(isLabelRefusal(new Error("socket hang up"))).toBe(false);
  });

  test("a refused number is asked again after six hours", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(
      labelsWorthTrying({ labelsSupported: null, labelsCheckedAt: null }, now),
    ).toBe(true);
    expect(
      labelsWorthTrying(
        {
          labelsSupported: false,
          labelsCheckedAt: new Date("2026-09-29T08:00:00Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      labelsWorthTrying(
        {
          labelsSupported: false,
          labelsCheckedAt: new Date("2026-09-29T05:59:00Z"),
        },
        now,
      ),
    ).toBe(true);
  });
});

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function client(
  respond: (c: Call) => Response,
  calls: Call[] = [],
): { ryze: RyzeClient; calls: Call[] } {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    ryze: new RyzeClient(
      { baseUrl: "https://ryze.test", instance: "amanda", token: "tok" },
      fetchImpl,
    ),
    calls,
  };
}

describe("RyzeClient labels", () => {
  test("listTags reads the tags with the instance token", async () => {
    const { ryze, calls } = client(() =>
      Response.json({
        success: true,
        tags: [
          { id: "1", name: "Novo cliente", color: 1, deleted: false },
          { id: 2, name: "Pago", color: "3", deleted: true },
          { id: "", name: "sem id" },
        ],
        total: 3,
      }),
    );
    expect(await ryze.listTags()).toEqual([
      { id: "1", name: "Novo cliente", color: 1, deleted: false },
      { id: "2", name: "Pago", color: 3, deleted: true },
    ]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/api/chat/tag/amanda");
    expect(calls[0]?.headers.token).toBe("tok");
  });

  test("createTag posts name and color and returns the new tag", async () => {
    const { ryze, calls } = client(() =>
      Response.json({
        success: true,
        tag: { id: "7", name: "VIP", color: 4, type: "CUSTOM", deleted: false },
      }),
    );
    expect(await ryze.createTag("VIP", 4)).toEqual({
      id: "7",
      name: "VIP",
      color: 4,
      deleted: false,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ name: "VIP", color: 4 });
  });

  test("deleteTag, assignTag and unassignTag hit their endpoints", async () => {
    const { ryze, calls } = client(() => Response.json({ success: true }));
    await ryze.deleteTag("3");
    await ryze.assignTag("5511999999999", "2");
    await ryze.unassignTag("5511999999999", "2");
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
      "DELETE /api/chat/tag/amanda?tagId=3",
      "POST /api/chat/assignTag/amanda",
      "DELETE /api/chat/assignTag/amanda?number=5511999999999&tagId=2",
    ]);
    expect(calls[1]?.body).toEqual({ number: "5511999999999", tagId: "2" });
  });

  test("a missing tag surfaces as a 404 with Ryze's message", async () => {
    const { ryze } = client(
      () =>
        new Response(JSON.stringify({ error: { message: "Tag not found" } }), {
          status: 404,
        }),
    );
    const err = await ryze.deleteTag("9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RyzeApiError);
    expect((err as RyzeApiError).status).toBe(404);
    expect((err as RyzeApiError).detail).toBe("Tag not found");
  });

  test("the webhook subscribes label.update beside messages and state", async () => {
    const { ryze, calls } = client(() => Response.json({ success: true }));
    await ryze.configureWebhook({
      url: "https://x.test/h",
      authorization: "a",
    });
    expect(calls[0]?.body?.events).toEqual([
      "message.exchange",
      "instance.state",
      "label.update",
    ]);
  });
});
