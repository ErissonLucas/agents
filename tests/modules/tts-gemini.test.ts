import { describe, expect, test } from "bun:test";
import { oggCrc, pcmToOggOpus } from "@/modules/tts/ogg-opus";
import {
  geminiPcm,
  getTtsProvider,
  pickTtsFormat,
  TtsError,
} from "@/modules/tts/providers";
import { readTtsConfig } from "@/modules/tts/settings";
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

function geminiFetch(pcm: Int16Array<ArrayBuffer>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body =
      status === 200
        ? {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "audio/L16;codec=pcm;rate=24000",
                        data: Buffer.from(pcm.buffer).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }
        : { error: { code: status, status: "INVALID_ARGUMENT" } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const REQ = {
  text: "olá, tudo bem?",
  voice: "Kore",
  model: "gemini-2.5-flash-preview-tts",
  language: "pt",
  apiKey: "g-key",
  baseURL: null,
};

interface OggPage {
  flags: number;
  granule: bigint;
  seq: number;
  packets: Uint8Array[];
  crcOk: boolean;
}

// Splits an Ogg stream into pages, checking every page's CRC. Packets never span pages here.
function readOgg(bytes: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  let off = 0;
  while (off < bytes.byteLength) {
    expect(String.fromCharCode(...bytes.subarray(off, off + 4))).toBe("OggS");
    const view = new DataView(bytes.buffer, bytes.byteOffset + off);
    const nSeg = view.getUint8(26);
    const lacing = [...bytes.subarray(off + 27, off + 27 + nSeg)];
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const page = new Uint8Array(bytes.subarray(off, off + 27 + nSeg + bodyLen));
    const crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    const packets: Uint8Array[] = [];
    let p = off + 27 + nSeg;
    let len = 0;
    for (const l of lacing) {
      len += l;
      if (l < 255) {
        packets.push(bytes.subarray(p, p + len));
        p += len;
        len = 0;
      }
    }
    pages.push({
      flags: view.getUint8(5),
      granule: view.getBigInt64(6, true),
      seq: view.getUint32(18, true),
      packets,
      crcOk: oggCrc(page) === crc,
    });
    off += 27 + nSeg + bodyLen;
  }
  return pages;
}

describe("Gemini TTS", () => {
  test("posts generateContent with the AUDIO modality, the voice and the key header", async () => {
    const { calls, fetchImpl } = geminiFetch(sine(4800));
    await getTtsProvider("gemini")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "wav",
    });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("g-key");
    expect(calls[0]?.url).not.toContain("g-key");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [{ parts: [{ text: "olá, tudo bem?" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        },
      },
    });
  });

  test("wav wraps the decoded PCM byte for byte", async () => {
    const pcm = sine(4800);
    const { fetchImpl } = geminiFetch(pcm);
    const out = await getTtsProvider("gemini")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "wav",
    });
    expect(out?.mime).toBe("audio/wav");
    expect(new Uint8Array(out?.audio ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(pcmToWav(pcm.buffer, RATE)),
    );
  });

  test("ogg_opus is an Ogg stream with OpusHead, OpusTags and trimmed audio pages", async () => {
    const samples = RATE * 2 + 77;
    const { fetchImpl } = geminiFetch(sine(samples));
    const out = await getTtsProvider("gemini")?.synthesize({
      ...REQ,
      fetchImpl,
      format: "ogg_opus",
    });
    expect(out?.mime).toBe("audio/ogg");
    expect(out?.fileName).toBe("reply.ogg");
    const bytes = new Uint8Array(out?.audio ?? new ArrayBuffer(0));
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OggS");

    const pages = readOgg(bytes);
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
    const head = pages[0]?.packets[0] ?? new Uint8Array();
    expect(pages[0]?.flags).toBe(0x02);
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    const headView = new DataView(head.buffer, head.byteOffset);
    expect(headView.getUint8(9)).toBe(1);
    expect(headView.getUint16(10, true)).toBe(312);
    expect(headView.getUint32(12, true)).toBe(RATE);
    const tags = pages[1]?.packets[0] ?? new Uint8Array();
    expect(new TextDecoder().decode(tags.subarray(0, 8))).toBe("OpusTags");

    const audioPages = pages.slice(2);
    const packets = audioPages.flatMap((p) => p.packets);
    // NOTE: 20 ms frames over the input plus the pre-skip padding.
    expect(packets.length).toBe(Math.ceil((samples + 156) / 480));
    const last = audioPages[audioPages.length - 1];
    expect(last?.flags).toBe(0x04);
    expect(last?.granule).toBe(BigInt(312 + samples * 2));
  });

  test("a RIFF body is unwrapped and its sample rate honored", () => {
    const pcm = sine(100);
    const wav = new Uint8Array(pcmToWav(pcm.buffer, 16_000));
    const { pcm: raw, sampleRate } = geminiPcm(wav, "audio/wav");
    expect(sampleRate).toBe(16_000);
    expect(new Uint8Array(raw)).toEqual(new Uint8Array(pcm.buffer));
  });

  test("an error response keeps Google's status slug, never the body text", async () => {
    const { fetchImpl } = geminiFetch(sine(10), 400);
    const err = await getTtsProvider("gemini")
      ?.synthesize({ ...REQ, fetchImpl, format: "ogg_opus" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe("INVALID_ARGUMENT");
  });

  test("is registered: ogg_opus on WhatsApp, wav on Instagram, accepted by settings", () => {
    const provider = getTtsProvider("gemini");
    expect(provider?.defaultVoice).toBe("Kore");
    if (!provider) throw new Error("gemini missing");
    expect(pickTtsFormat(provider, "Channel::Whatsapp")).toBe("ogg_opus");
    expect(pickTtsFormat(provider, "Channel::Instagram")).toBe("wav");
    expect(readTtsConfig({ tts: { provider: "gemini" } }).provider).toBe(
      "gemini",
    );
  });

  test("pcmToOggOpus refuses a rate Opus cannot encode", async () => {
    await expect(pcmToOggOpus(new ArrayBuffer(4), 22_050)).rejects.toThrow(
      RangeError,
    );
  });
});
