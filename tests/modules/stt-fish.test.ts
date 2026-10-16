import { describe, expect, test } from "bun:test";
import {
  cleanFishTranscript,
  getSttProvider,
  makeFishTranscribe,
  SttError,
} from "@/modules/stt/providers";
import { readSttConfig } from "@/modules/stt/settings";

interface Call {
  url: string;
  init: RequestInit;
}

function scriptedFetch(replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2]).buffer;
const REQ = {
  audio,
  mimeType: "audio/ogg; codecs=opus",
  language: "pt-BR",
  model: "transcribe-1-pro",
  apiKey: "fish-key",
  baseURL: null,
};
const fast = makeFishTranscribe({ budgetMs: 2_000, retryDelayMs: 1 });

describe("Fish Audio STT", () => {
  test("posts multipart audio with the model header, language pt, and cleans the markers", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      {
        body: {
          text: "<|speaker:0|>Oi, [laughter] tudo bem?<|speaker:1|> Tudo ótimo.",
          duration: 2.1,
          segments: [],
          language_code: "pt",
        },
      },
    ]);
    const text = await getSttProvider("fish")?.transcribe({
      ...REQ,
      fetchImpl,
    });
    expect(text).toBe("Oi, tudo bem? Tudo ótimo.");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://api.fish.audio/v1/asr");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fish-key");
    expect(headers.model).toBe("transcribe-1-pro");
    // NOTE: no content-type of ours: fetch sets the multipart boundary.
    expect(headers["content-type"]).toBeUndefined();
    const form = calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("language")).toBe("pt");
    expect(form.get("ignore_timestamps")).toBe("true");
    const file = form.get("audio") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(audio),
    );
  });

  test("the registry default model is transcribe-1-pro", () => {
    expect(getSttProvider("fish")?.defaultModel).toBe("transcribe-1-pro");
    expect(readSttConfig({ stt: { provider: "fish" } }).provider).toBe("fish");
  });

  test("cleanFishTranscript keeps ordinary brackets and text", () => {
    expect(cleanFishTranscript("  <|speaker:2|>olá  [Música]  mundo ")).toBe(
      "olá [Música] mundo",
    );
    expect(cleanFishTranscript("[applause] [laughter]")).toBe("");
  });

  for (const [status, reason] of [
    [401, "invalid_api_key"],
    [402, "insufficient_credit"],
  ] as const) {
    test(`${status} fails at once with our slug, no body text`, async () => {
      const { calls, fetchImpl } = scriptedFetch([
        { status, body: { status, message: "the customer said hello" } },
      ]);
      const err = await fast({ ...REQ, fetchImpl }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).status).toBe(status);
      expect((err as SttError).reason).toBe(reason);
      expect((err as SttError).message).not.toContain("customer");
      expect(calls.length).toBe(1);
    });
  }

  test("503 is retried once, then the transcript comes back", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 503, body: { status: 503, message: "busy" } },
      { body: { text: "olá", duration: 1, segments: [] } },
    ]);
    expect(await fast({ ...REQ, fetchImpl })).toBe("olá");
    expect(calls.length).toBe(2);
  });

  test("a 503 that persists fails as overloaded", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 503, body: { status: 503, message: "busy" } },
    ]);
    const err = await fast({ ...REQ, fetchImpl }).catch((e: unknown) => e);
    expect((err as SttError).reason).toBe("overloaded");
    expect(calls.length).toBe(2);
  });
});
