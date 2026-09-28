import { describe, expect, test } from "bun:test";
import {
  getSttProvider,
  makeAssemblyaiTranscribe,
  SttError,
} from "@/modules/stt/providers";
import { readSttConfig } from "@/modules/stt/settings";

interface Call {
  url: string;
  init: RequestInit;
}

// Answers each request with the next scripted reply, in order, and records what was sent.
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

const audio = new Uint8Array([1, 2, 3, 4]).buffer;
const REQ = {
  audio,
  mimeType: "audio/ogg",
  language: "pt-BR",
  model: "universal-3-5-pro",
  apiKey: "aai-key",
  baseURL: null,
};
const fast = makeAssemblyaiTranscribe({ budgetMs: 2_000, pollDelaysMs: [1] });

describe("AssemblyAI STT", () => {
  test("uploads the bytes, submits the job, polls until completed", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { body: { upload_url: "https://cdn.assemblyai.com/upload/abc" } },
      { body: { id: "tx-1", status: "queued" } },
      { body: { id: "tx-1", status: "processing" } },
      { body: { id: "tx-1", status: "completed", text: " olá mundo " } },
    ]);
    const text = await fast({ ...REQ, fetchImpl });
    expect(text).toBe("olá mundo");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST https://api.assemblyai.com/v2/upload",
      "POST https://api.assemblyai.com/v2/transcript",
      "GET https://api.assemblyai.com/v2/transcript/tx-1",
      "GET https://api.assemblyai.com/v2/transcript/tx-1",
    ]);
    for (const c of calls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("aai-key");
      expect(c.init.redirect).toBe("error");
    }
    expect(calls[0]?.init.body).toBe(audio);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      audio_url: "https://cdn.assemblyai.com/upload/abc",
      speech_models: ["universal-3-5-pro"],
      language_code: "pt",
    });
  });

  test("a job that ends in error throws SttError without the provider text", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { upload_url: "https://cdn/u" } },
      { body: { id: "tx-2" } },
      { body: { status: "error", error: "Olá, contains customer words" } },
    ]);
    const err = await fast({ ...REQ, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).reason).toBe("transcript_error");
    expect((err as SttError).message).not.toContain("customer");
  });

  test("a job still queued at the deadline times out", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { body: { upload_url: "https://cdn/u" } },
      { body: { id: "tx-3" } },
      { body: { status: "queued" } },
    ]);
    const slow = makeAssemblyaiTranscribe({ budgetMs: 60, pollDelaysMs: [20] });
    const err = await slow({ ...REQ, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).status).toBe(504);
    expect((err as SttError).reason).toBe("poll_timeout");
    expect(calls.length).toBeLessThan(10);
  });

  test("an HTTP failure on upload surfaces its status", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 401, body: { error: "Invalid API key" } },
    ]);
    const err = await fast({ ...REQ, fetchImpl }).catch((e: unknown) => e);
    expect((err as SttError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("is registered with its default model and accepted by the settings reader", () => {
    expect(getSttProvider("assemblyai")?.defaultModel).toBe(
      "universal-3-5-pro",
    );
    expect(readSttConfig({ stt: { provider: "assemblyai" } }).provider).toBe(
      "assemblyai",
    );
  });
});
