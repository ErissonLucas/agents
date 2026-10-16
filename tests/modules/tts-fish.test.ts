import { describe, expect, test } from "bun:test";
import type { TenantContext } from "@/lib/tenancy";
import { type KeyResolver, listTtsOptions } from "@/modules/tts/listing";
import { oggCrc } from "@/modules/tts/ogg-opus";
import {
  getTtsProvider,
  makeFishSynthesize,
  pickTtsFormat,
  TtsError,
} from "@/modules/tts/providers";
import { readTtsConfig, voiceSettingsOf } from "@/modules/tts/settings";
import { pcmToWav } from "@/modules/tts/wav";

interface Call {
  url: string;
  init: RequestInit;
}

const RATE = 24_000;

function sine(samples: number): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / RATE));
  }
  return pcm;
}

// Answers each request with the next scripted reply, in order: raw bytes on 200, a Fish error body
// otherwise.
function fishFetch(replies: { status?: number; bytes?: ArrayBuffer }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = next?.status ?? 200;
    if (status === 200) {
      return new Response(next?.bytes ?? new ArrayBuffer(0), {
        status,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response(
      JSON.stringify({
        status,
        message: "Account balance is insufficient for user abc@x.com",
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const REQ = {
  text: "olá, tudo bem?",
  voice: "802e3bc2b27e49c2995d23ef70e6ac89",
  model: "s2.1-pro",
  language: "",
  apiKey: "fish-key",
  baseURL: null,
};

const fast = makeFishSynthesize({ budgetMs: 2_000, retryDelayMs: 1 });

describe("Fish Audio TTS", () => {
  test("posts /v1/tts with Bearer, the model header and reference_id, asking for 24 kHz PCM", async () => {
    const { calls, fetchImpl } = fishFetch([{ bytes: sine(4800).buffer }]);
    await getTtsProvider("fish")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "ogg_opus",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://api.fish.audio/v1/tts");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fish-key");
    expect(headers.model).toBe("s2.1-pro");
    expect(headers["content-type"]).toBe("application/json");
    // NOTE: no knob set → no latency and no prosody, so Fish applies its own defaults.
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      text: "olá, tudo bem?",
      reference_id: "802e3bc2b27e49c2995d23ef70e6ac89",
      format: "pcm",
      sample_rate: 24_000,
    });
  });

  test("ogg_opus is a valid Ogg/Opus voice note built from the PCM", async () => {
    const samples = RATE + 123;
    const { fetchImpl } = fishFetch([{ bytes: sine(samples).buffer }]);
    const out = await getTtsProvider("fish")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "ogg_opus",
    });
    expect(out?.mime).toBe("audio/ogg");
    expect(out?.fileName).toBe("reply.ogg");
    const bytes = new Uint8Array(out?.audio ?? new ArrayBuffer(0));
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OggS");
    // The first page carries OpusHead at the PCM's rate, and every page's CRC checks out.
    const nSeg = bytes[26] ?? 0;
    const head = bytes.subarray(27 + nSeg);
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    expect(new DataView(head.buffer, head.byteOffset).getUint32(12, true)).toBe(
      RATE,
    );
    let off = 0;
    let pages = 0;
    let lastFlags = 0;
    while (off < bytes.byteLength) {
      expect(String.fromCharCode(...bytes.subarray(off, off + 4))).toBe("OggS");
      const segs = bytes[off + 26] ?? 0;
      const lacing = bytes.subarray(off + 27, off + 27 + segs);
      const len = 27 + segs + lacing.reduce((a, b) => a + b, 0);
      const page = new Uint8Array(bytes.subarray(off, off + len));
      const crc = new DataView(page.buffer).getUint32(22, true);
      page.fill(0, 22, 26);
      expect(oggCrc(page)).toBe(crc);
      lastFlags = page[5] ?? 0;
      off += len;
      pages++;
    }
    expect(pages).toBeGreaterThan(2);
    expect(lastFlags).toBe(0x04);
  });

  test("wav wraps the PCM byte for byte; mp3 is asked for natively", async () => {
    const pcm = sine(480);
    const wav = fishFetch([{ bytes: pcm.buffer }]);
    const out = await getTtsProvider("fish")?.synthesize({
      ...REQ,
      fetchImpl: wav.fetchImpl,
      format: "wav",
    });
    expect(out?.mime).toBe("audio/wav");
    expect(new Uint8Array(out?.audio ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(pcmToWav(pcm.buffer, RATE)),
    );

    const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer;
    const mp3 = fishFetch([{ bytes: mp3Bytes }]);
    const outMp3 = await getTtsProvider("fish")?.synthesize({
      ...REQ,
      fetchImpl: mp3.fetchImpl,
      format: "mp3",
    });
    expect(outMp3?.mime).toBe("audio/mpeg");
    expect(new Uint8Array(outMp3?.audio ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(mp3Bytes),
    );
    const body = JSON.parse(String(mp3.calls[0]?.init.body));
    expect(body.format).toBe("mp3");
    expect(body.mp3_bitrate).toBe(128);
    expect(body.sample_rate).toBeUndefined();
  });

  test("speed goes as prosody.speed clamped to 0.5-2, latency as set", async () => {
    const { calls, fetchImpl } = fishFetch([{ bytes: sine(480).buffer }]);
    const cfg = readTtsConfig({
      tts: { provider: "fish", speed: 3, latency: "balanced" },
    });
    await getTtsProvider("fish")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "wav",
      voiceSettings: voiceSettingsOf(cfg),
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.prosody).toEqual({ speed: 2 });
    expect(body.latency).toBe("balanced");
  });

  test("an unknown latency is read as unset", () => {
    expect(readTtsConfig({ tts: { latency: "turbo" } }).latency).toBeNull();
    expect(readTtsConfig({ tts: { latency: "low" } }).latency).toBe("low");
  });

  for (const [status, code] of [
    [401, "invalid_api_key"],
    [402, "insufficient_credit"],
  ] as const) {
    test(`${status} fails at once with our slug, never the provider's message`, async () => {
      const { calls, fetchImpl } = fishFetch([{ status }]);
      const err = await fast({ ...REQ, fetchImpl, format: "ogg_opus" }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TtsError);
      expect((err as TtsError).status).toBe(status);
      expect((err as TtsError).code).toBe(code);
      expect((err as TtsError).message).not.toContain("abc@x.com");
      expect(calls.length).toBe(1);
    });
  }

  test("503 is retried once, then succeeds", async () => {
    const { calls, fetchImpl } = fishFetch([
      { status: 503 },
      { bytes: sine(480).buffer },
    ]);
    const out = await fast({ ...REQ, fetchImpl, format: "wav" });
    expect(out.mime).toBe("audio/wav");
    expect(calls.length).toBe(2);
  });

  test("503 twice fails as overloaded", async () => {
    const { calls, fetchImpl } = fishFetch([{ status: 503 }]);
    const err = await fast({ ...REQ, fetchImpl, format: "wav" }).catch(
      (e: unknown) => e,
    );
    expect((err as TtsError).code).toBe("overloaded");
    expect(calls.length).toBe(2);
  });

  test("an empty 200 is no audio, not an empty voice note", async () => {
    const { fetchImpl } = fishFetch([{ bytes: new ArrayBuffer(0) }]);
    const err = await fast({ ...REQ, fetchImpl, format: "ogg_opus" }).catch(
      (e: unknown) => e,
    );
    expect((err as TtsError).code).toBe("no_audio");
  });

  test("is registered: voice required, ogg_opus on WhatsApp, wav on Instagram", () => {
    const provider = getTtsProvider("fish");
    if (!provider) throw new Error("fish missing");
    expect(provider.requiresVoice).toBe(true);
    expect(provider.defaultModel).toBe("s2.1-pro");
    expect(pickTtsFormat(provider, "Channel::Whatsapp")).toBe("ogg_opus");
    expect(pickTtsFormat(provider, "Channel::Instagram")).toBe("wav");
    expect(provider.providerFormat("ogg_opus")).toBe("pcm_s16le_24000");
    expect(readTtsConfig({ tts: { provider: "fish" } }).provider).toBe("fish");
  });
});

describe("Fish Audio voice listing", () => {
  const ctx: TenantContext = {
    tenantId: 1n,
    userId: null,
    role: "TENANT_ADMIN",
  };
  const noDb = null as never;
  const passthroughSafe = async (url: string) => new URL(url);
  const resolvesKey: KeyResolver = async () => "fish-key";

  function listingFetch(pages: unknown[]) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = pages[calls.length - 1] ?? { total: 0, items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("lists the account's voices, then public Portuguese ones, deduplicated", async () => {
    const { calls, fetchImpl } = listingFetch([
      {
        total: 2,
        items: [
          { _id: "mine1", title: "Clara", type: "tts", state: "trained" },
          { _id: "draft", title: "Draft", type: "tts", state: "training" },
        ],
      },
      {
        total: 2,
        items: [
          { _id: "pub1", title: "Narrador", type: "tts", state: "trained" },
          { _id: "mine1", title: "Clara", type: "tts", state: "trained" },
        ],
      },
    ]);
    const items = await listTtsOptions(
      ctx,
      { provider: "fish", kind: "voices", credentialRef: "vault:1" },
      noDb,
      fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items).toEqual([
      { id: "mine1", label: "Clara" },
      { id: "pub1", label: "Narrador" },
    ]);
    expect(calls[0]?.url).toBe(
      "https://api.fish.audio/model?self=true&page_size=50&sort_by=created_at",
    );
    expect(calls[1]?.url).toBe(
      "https://api.fish.audio/model?language=pt&page_size=50&sort_by=task_count",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer fish-key");
  });

  test("models are curated and need no credential; s1 is not offered", async () => {
    const items = await listTtsOptions(
      ctx,
      { provider: "fish", kind: "models" },
      noDb,
      listingFetch([]).fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items.map((i) => i.id)).toEqual([
      "s2.1-pro",
      "s2-pro",
      "s2.1-pro-free",
      "drama-3",
    ]);
  });

  test("voices without a credential are refused", async () => {
    await expect(
      listTtsOptions(
        ctx,
        { provider: "fish", kind: "voices" },
        noDb,
        listingFetch([]).fetchImpl,
        passthroughSafe,
        resolvesKey,
      ),
    ).rejects.toThrow("A credential is required");
  });

  test("a search goes to Fish as `title`: the account's, then public Portuguese, then any language", async () => {
    const { calls, fetchImpl } = listingFetch([
      {
        items: [{ _id: "mine1", title: "Ana", type: "tts", state: "trained" }],
      },
      {
        items: [{ _id: "pt1", title: "Ana BR", type: "tts", state: "trained" }],
      },
      {
        items: [
          { _id: "pt1", title: "Ana BR", type: "tts", state: "trained" },
          { _id: "en1", title: "Anna", type: "tts", state: "trained" },
        ],
      },
    ]);
    const items = await listTtsOptions(
      ctx,
      {
        provider: "fish",
        kind: "voices",
        credentialRef: "vault:1",
        search: " Ana Clara ",
      },
      noDb,
      fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items.map((i) => i.id)).toEqual(["mine1", "pt1", "en1"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.fish.audio/model?self=true&title=Ana%20Clara&page_size=50&sort_by=created_at",
      "https://api.fish.audio/model?title=Ana%20Clara&language=pt&page_size=50&sort_by=task_count",
      "https://api.fish.audio/model?title=Ana%20Clara&page_size=50&sort_by=task_count",
    ]);
  });

  test("a voice id is looked up with GET /model/{id} and answers its title", async () => {
    const id = "802e3bc2b27e49c2995d23ef70e6ac89";
    const { calls, fetchImpl } = listingFetch([
      { _id: id, title: "Narrador Energético", type: "tts", state: "trained" },
    ]);
    const items = await listTtsOptions(
      ctx,
      {
        provider: "fish",
        kind: "voices",
        credentialRef: "vault:1",
        search: id.toUpperCase(),
      },
      noDb,
      fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items).toEqual([{ id, label: "Narrador Energético" }]);
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.fish.audio/model/${id}`,
    ]);
  });

  test("an id Fish does not know answers no items, not an error", async () => {
    const fetchImpl = (async () =>
      new Response('{"detail":"Not Found"}', {
        status: 404,
      })) as unknown as typeof fetch;
    const items = await listTtsOptions(
      ctx,
      {
        provider: "fish",
        kind: "voices",
        credentialRef: "vault:1",
        search: "00000000000000000000000000000000",
      },
      noDb,
      fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items).toEqual([]);
  });

  test("a search is ignored where the list is local", async () => {
    const items = await listTtsOptions(
      ctx,
      { provider: "gemini", kind: "voices", search: "zzz" },
      noDb,
      listingFetch([]).fetchImpl,
      passthroughSafe,
      resolvesKey,
    );
    expect(items[0]?.id).toBe("Kore");
  });

  test("a 401 from the listing is a provider failure carrying the status", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const err = await listTtsOptions(
      ctx,
      { provider: "fish", kind: "voices", credentialRef: "vault:1" },
      noDb,
      fetchImpl,
      passthroughSafe,
      resolvesKey,
    ).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(502);
    expect((err as Error).message).toContain("401");
  });
});
