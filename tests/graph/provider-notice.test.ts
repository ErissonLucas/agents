import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { isFallbackWorthy } from "@/graph/model-fallback";
import { runModelCall } from "@/graph/model-limit";
import {
  isProviderNotice,
  isProviderNoticeText,
  ProviderNoticeFault,
} from "@/graph/provider-notice";

const ANTIGRAVITY_NOTICE =
  "This version of Antigravity is no longer supported. Please download and install the latest version at https://antigravity.google/download to continue using the agent and unlock our latest models, including Gemini 4 Argon on eligible plans.";

describe("provider notices", () => {
  test("the notice a deprecated Antigravity client receives is one", () => {
    expect(isProviderNoticeText(ANTIGRAVITY_NOTICE)).toBe(true);
    expect(isProviderNotice(new AIMessage(ANTIGRAVITY_NOTICE))).toBe(true);
  });

  test("a retired model and an exhausted quota answered as text are notices", () => {
    expect(
      isProviderNoticeText(
        "The model claude-sonnet-4-6 is no longer available.",
      ),
    ).toBe(true);
    expect(isProviderNoticeText("You've hit your usage limit.")).toBe(true);
    expect(isProviderNoticeText("Rate limit exceeded")).toBe(true);
  });

  test("an ordinary reply is not, even one that mentions a limit", () => {
    expect(isProviderNoticeText("Olá! Entregamos sim, qual o seu CEP?")).toBe(
      false,
    );
    expect(
      isProviderNoticeText(
        "O limite de entrega é de 5 km. Esse modelo de pedido não está mais disponível no cardápio.",
      ),
    ).toBe(false);
    expect(isProviderNoticeText("")).toBe(false);
  });

  test("a long answer quoting a notice is not one", () => {
    expect(
      isProviderNoticeText(`${ANTIGRAVITY_NOTICE} ${"x".repeat(700)}`),
    ).toBe(false);
  });

  test("a message carrying tool calls is never a notice", () => {
    const msg = new AIMessage({
      content: ANTIGRAVITY_NOTICE,
      tool_calls: [{ id: "1", name: "search", args: {} }],
    });
    expect(isProviderNotice(msg)).toBe(false);
  });

  test("content parts are read like a string", () => {
    const msg = new AIMessage({
      content: [{ type: "text", text: ANTIGRAVITY_NOTICE }],
    });
    expect(isProviderNotice(msg)).toBe(true);
  });

  test("the fault hands the turn to a fallback", () => {
    expect(isFallbackWorthy(new ProviderNoticeFault())).toBe(true);
  });
});

describe("runModelCall with a provider notice", () => {
  test("with a fallback, the fallback answers and the notice never comes out", async () => {
    let primaryCalls = 0;
    const reply = await runModelCall<AIMessage>(
      () => {
        primaryCalls += 1;
        return Promise.resolve(new AIMessage(ANTIGRAVITY_NOTICE));
      },
      {
        primary: { provider: "openai", model: "agy" },
        fallback: {
          labels: { provider: "openai", model: "other" },
          deadlineMs: 5_000,
          run: () => Promise.resolve(new AIMessage("Entregamos sim!")),
        },
      },
    );
    expect(reply.content).toBe("Entregamos sim!");
    expect(primaryCalls).toBe(1);
  });

  test("without a fallback, the call fails with our sentence, not the provider's", async () => {
    const err = (await runModelCall<AIMessage>(() =>
      Promise.resolve(new AIMessage(ANTIGRAVITY_NOTICE)),
    ).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("Antigravity");
    expect(err.message).toContain("service notice");
  });

  test("an ordinary completion passes through untouched", async () => {
    const reply = await runModelCall<AIMessage>(() =>
      Promise.resolve(new AIMessage("Olá!")),
    );
    expect(reply.content).toBe("Olá!");
  });
});
