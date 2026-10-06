import { describe, expect, test } from "bun:test";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import {
  judgeReplyGate,
  REPLY_GATE_DEFAULTS,
  type ReplyGateConfig,
  type ReplyGateSnapshot,
  readReplyGateConfig,
  replyGateControlLabels,
  replyGateLabelsAfterGrant,
  replyGateLabelsAfterHandoff,
} from "@/modules/agents/reply-gate";
import {
  assertSettingsReplyGate,
  ReplyGateNeedsLabelError,
  ReplyGateSameLabelsError,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";

// The reply gate's pure half (docs/LIVARE-F21-PORTAO-ETIQUETA.md): the reader, the verdict and the
// label moves of a hand-off and a grant. The seams that ask it run against the database in
// tests/modules/ryze-reply-gate.test.ts.

const ON: ReplyGateConfig = {
  enabled: true,
  requiredLabel: "ia-atendendo",
  handoffLabel: "com-vendedor",
  removeOnHandoff: true,
};
const catalog = (
  rows: { title: string; tagId?: string | null; autoRule?: string | null }[],
) =>
  rows.map((r) => ({
    title: r.title,
    tagId: r.tagId === undefined ? "T1" : r.tagId,
    autoRule: r.autoRule ?? null,
  }));
const ryze = (
  labels: string[],
  rows = catalog([{ title: "ia-atendendo" }]),
  labelsSupported: boolean | null = true,
): ReplyGateSnapshot => ({
  labels,
  ryze: { catalog: rows, labelsSupported },
});

describe("readReplyGateConfig", () => {
  test("absent, or anything but an explicit true, is off — every existing agent keeps answering", () => {
    expect(readReplyGateConfig({})).toEqual(REPLY_GATE_DEFAULTS);
    expect(readReplyGateConfig(null)).toEqual(REPLY_GATE_DEFAULTS);
    expect(readReplyGateConfig({ replyGate: [] })).toEqual(REPLY_GATE_DEFAULTS);
    expect(
      readReplyGateConfig({ replyGate: { enabled: "true" } }).enabled,
    ).toBe(false);
    expect(readBehaviorSettings({}).replyGate.enabled).toBe(false);
  });

  test("trims labels, blank is none, removeOnHandoff defaults to true", () => {
    expect(
      readReplyGateConfig({
        replyGate: {
          enabled: true,
          requiredLabel: "  ia  ",
          handoffLabel: " ",
        },
      }),
    ).toEqual({
      enabled: true,
      requiredLabel: "ia",
      handoffLabel: null,
      removeOnHandoff: true,
    });
  });

  test("the control labels are guarded only while the gate is on", () => {
    expect(replyGateControlLabels(ON)).toEqual([
      "ia-atendendo",
      "com-vendedor",
    ]);
    expect(replyGateControlLabels({ ...ON, enabled: false })).toEqual([]);
  });
});

describe("judgeReplyGate", () => {
  test("off: open whatever the labels say", () => {
    expect(judgeReplyGate(REPLY_GATE_DEFAULTS, ryze([]))).toEqual({
      open: true,
    });
  });

  test("on without a label to require: closed, not open", () => {
    expect(
      judgeReplyGate({ ...ON, requiredLabel: null }, ryze(["ia-atendendo"])),
    ).toEqual({ open: false, reason: "no_required_label" });
  });

  test("RyzeAPI: present, in the catalog and synced is the only open answer", () => {
    expect(judgeReplyGate(ON, ryze(["IA-Atendendo"]))).toEqual({ open: true });
    expect(judgeReplyGate(ON, ryze([]))).toEqual({
      open: false,
      reason: "label_missing",
    });
    expect(judgeReplyGate(ON, ryze(["ia-atendendo"], []))).toEqual({
      open: false,
      reason: "label_unknown",
    });
    expect(
      judgeReplyGate(
        ON,
        ryze(
          ["ia-atendendo"],
          catalog([{ title: "ia-atendendo", tagId: null }]),
        ),
      ),
    ).toEqual({ open: false, reason: "label_unsynced" });
    expect(
      judgeReplyGate(ON, ryze(["ia-atendendo"], undefined, false)),
    ).toEqual({ open: false, reason: "label_unsynced" });
  });

  test("the hand-off label and a human_takeover label close it even with the required label on", () => {
    expect(judgeReplyGate(ON, ryze(["ia-atendendo", "com-vendedor"]))).toEqual({
      open: false,
      reason: "handed_off",
    });
    expect(
      judgeReplyGate(
        ON,
        ryze(
          ["ia-atendendo", "humano"],
          catalog([
            { title: "ia-atendendo" },
            { title: "humano", autoRule: "human_takeover" },
          ]),
        ),
      ),
    ).toEqual({ open: false, reason: "human_takeover" });
  });

  test("Chatwoot (no catalog): the label alone decides", () => {
    expect(
      judgeReplyGate(ON, { labels: ["ia-atendendo"], ryze: null }),
    ).toEqual({ open: true });
    expect(judgeReplyGate(ON, { labels: [], ryze: null })).toEqual({
      open: false,
      reason: "label_missing",
    });
  });
});

describe("the label moves", () => {
  test("a hand-off takes the required label off and puts the hand-off one on, once", () => {
    const after = replyGateLabelsAfterHandoff(ON, ["etapa-1", "ia-atendendo"]);
    expect(after).toEqual(["etapa-1", "com-vendedor"]);
    expect(replyGateLabelsAfterHandoff(ON, after)).toEqual(after);
  });

  test("removeOnHandoff false keeps the required label; an unknown hand-off label is not added", () => {
    expect(
      replyGateLabelsAfterHandoff({ ...ON, removeOnHandoff: false }, [
        "ia-atendendo",
      ]),
    ).toEqual(["ia-atendendo", "com-vendedor"]);
    expect(
      replyGateLabelsAfterHandoff(ON, ["ia-atendendo"], () => false),
    ).toEqual([]);
  });

  test("a grant puts the required label on and takes the hand-off one off", () => {
    expect(replyGateLabelsAfterGrant(ON, ["com-vendedor", "etapa-2"])).toEqual([
      "etapa-2",
      "ia-atendendo",
    ]);
    expect(replyGateLabelsAfterGrant(ON, ["ia-atendendo"])).toEqual([
      "ia-atendendo",
    ]);
  });
});

describe("the write boundary", () => {
  test("refuses a gate that could never open, only when the write changes it", () => {
    expect(() =>
      assertSettingsReplyGate({ replyGate: { enabled: true } }, {}),
    ).toThrow(ReplyGateNeedsLabelError);
    expect(() =>
      assertSettingsReplyGate(
        {
          replyGate: {
            enabled: true,
            requiredLabel: "ia",
            handoffLabel: "IA",
          },
        },
        {},
      ),
    ).toThrow(ReplyGateSameLabelsError);
    const stored = { replyGate: { enabled: true } };
    expect(() => assertSettingsReplyGate(stored, stored)).not.toThrow();
    expect(() =>
      assertSettingsReplyGate(
        { replyGate: { enabled: true, requiredLabel: "ia" } },
        {},
      ),
    ).not.toThrow();
    expect(() =>
      assertSettingsReplyGate({ replyGate: { enabled: false } }, {}),
    ).not.toThrow();
  });

  test("the MCP schema accepts the block and refuses a wrong type", () => {
    const schema = BEHAVIOR_PATCH_SHAPE.replyGate;
    expect(
      schema.safeParse({ enabled: true, requiredLabel: "ia" }).success,
    ).toBe(true);
    expect(schema.safeParse({ enabled: "yes" }).success).toBe(false);
  });
});
