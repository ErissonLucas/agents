// Speech-to-text provider abstraction. The OpenAI `/audio/transcriptions` multipart shape is a
// de-facto standard (Groq and most self-hosted Whisper servers implement it), so `openai` and
// `openai-compatible` share one adapter (baseURL switch). Gemini and ElevenLabs have their own
// shapes, so each gets a thin adapter; AssemblyAI is asynchronous (upload, submit, poll). Adding a
// provider = one function + one registry entry; a future generic/declarative provider can slot in
// behind the same interface without touching callers.

const STT_TIMEOUT_MS = 60_000;

export interface SttRequest {
  audio: ArrayBuffer;
  mimeType: string | null;
  language: string;
  model: string; // already resolved (provider default applied by the caller)
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
}

export interface SttProvider {
  defaultModel: string;
  // openai-compatible requires an explicit baseURL (no public default endpoint).
  requiresBaseURL?: boolean;
  transcribe(req: SttRequest): Promise<string>;
}

export class SttError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    // NOTE: a fixed slug of ours (never provider text) for failures that are not an HTTP status.
    readonly reason: string | null = null,
  ) {
    // NOTE: never capture the response body — it carries the (PII) transcription / provider detail.
    super(
      `STT ${provider} failed with ${status}${reason ? ` (${reason})` : ""}`,
    );
    this.name = "SttError";
  }
}

// WhatsApp voice notes are ogg/opus; map the mime to an extension the multipart APIs recognize.
function fileNameFor(mimeType: string | null): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "audio.ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac"))
    return "audio.m4a";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("flac")) return "audio.flac";
  return "audio.ogg";
}

function audioBlob(req: SttRequest): Blob {
  return new Blob([req.audio], { type: req.mimeType ?? "audio/ogg" });
}

// OpenAI Whisper + any OpenAI-compatible endpoint (Groq, self-hosted faster-whisper, …).
async function openaiTranscribe(req: SttRequest): Promise<string> {
  const base = (req.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", audioBlob(req), fileNameFor(req.mimeType));
  form.append("model", req.model);
  if (req.language) form.append("language", req.language);
  const res = await req.fetchImpl(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${req.apiKey}` },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new SttError("openai", res.status);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

// ElevenLabs Scribe.
async function elevenlabsTranscribe(req: SttRequest): Promise<string> {
  const base = (req.baseURL ?? "https://api.elevenlabs.io/v1").replace(
    /\/+$/,
    "",
  );
  const form = new FormData();
  form.append("file", audioBlob(req), fileNameFor(req.mimeType));
  form.append("model_id", req.model);
  if (req.language) form.append("language_code", req.language);
  const res = await req.fetchImpl(`${base}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": req.apiKey },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new SttError("elevenlabs", res.status);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

// Google Gemini: transcription via generateContent with the audio inlined as base64. The key goes in
// the x-goog-api-key header (not the URL) to keep it out of logs.
async function geminiTranscribe(req: SttRequest): Promise<string> {
  const base = (
    req.baseURL ?? "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
  const prompt = `Transcreva o áudio a seguir literalmente${
    req.language ? ` (idioma: ${req.language})` : ""
  }. Responda APENAS com a transcrição, sem comentários nem pontuação extra.`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: req.mimeType ?? "audio/ogg",
              data: Buffer.from(req.audio).toString("base64"),
            },
          },
        ],
      },
    ],
  };
  const res = await req.fetchImpl(
    `${base}/models/${encodeURIComponent(req.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": req.apiKey,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new SttError("gemini", res.status);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

// OpenRouter transcription: dedicated audio API (launched 2026-05-01), JSON + base64 — NOT the
// multipart shape `openaiTranscribe` uses, so it needs its own adapter. Maps the mime to the
// short format token OpenRouter expects (no "audio." prefix, unlike fileNameFor's multipart names).
function audioFormatFor(mimeType: string | null): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("flac")) return "flac";
  return "ogg";
}

async function openrouterTranscribe(req: SttRequest): Promise<string> {
  const base = (req.baseURL ?? "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    "",
  );
  const body: Record<string, unknown> = {
    model: req.model,
    input_audio: {
      data: Buffer.from(req.audio).toString("base64"),
      format: audioFormatFor(req.mimeType),
    },
  };
  if (req.language) body.language = req.language;
  const res = await req.fetchImpl(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) throw new SttError("openrouter", res.status);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

// AssemblyAI: upload the raw bytes, submit a transcript job for the returned URL, then poll the job
// until it settles. Every request of the three steps shares ONE deadline, the same budget the
// single-call adapters get, so a slow queue costs a skipped transcription and never a longer turn.
// A job that ends in `error` is reported by our own slug: its `error` field is provider prose.
export function makeAssemblyaiTranscribe(opts: {
  budgetMs: number;
  pollDelaysMs: readonly number[];
}): (req: SttRequest) => Promise<string> {
  return async (req) => {
    const base = (req.baseURL ?? "https://api.assemblyai.com/v2").replace(
      /\/+$/,
      "",
    );
    const deadline = Date.now() + opts.budgetMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const call = async (url: string, init: RequestInit) => {
      const res = await req.fetchImpl(url, {
        ...init,
        headers: { authorization: req.apiKey, ...init.headers },
        redirect: "error",
        signal: AbortSignal.timeout(remaining()),
      });
      if (!res.ok) throw new SttError("assemblyai", res.status);
      return (await res.json()) as Record<string, unknown>;
    };

    const uploaded = await call(`${base}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: req.audio,
    });
    const audioUrl = uploaded.upload_url;
    if (typeof audioUrl !== "string")
      throw new SttError("assemblyai", 502, "no_upload_url");

    const body: Record<string, unknown> = {
      audio_url: audioUrl,
      speech_models: [req.model],
    };
    // NOTE: AssemblyAI names languages by the base code ("pt"), with its own `_` regional ids.
    if (req.language)
      body.language_code = req.language.split("-")[0]?.toLowerCase();
    const job = await call(`${base}/transcript`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (typeof job.id !== "string")
      throw new SttError("assemblyai", 502, "no_transcript_id");

    const pollUrl = `${base}/transcript/${encodeURIComponent(job.id)}`;
    for (let attempt = 0; ; attempt++) {
      const delay =
        opts.pollDelaysMs[Math.min(attempt, opts.pollDelaysMs.length - 1)] ??
        1_000;
      if (Date.now() + delay >= deadline)
        throw new SttError("assemblyai", 504, "poll_timeout");
      await Bun.sleep(delay);
      const state = await call(pollUrl, { method: "GET" });
      if (state.status === "completed")
        return (typeof state.text === "string" ? state.text : "").trim();
      if (state.status === "error")
        throw new SttError("assemblyai", 502, "transcript_error");
    }
  };
}

const PROVIDERS: Record<string, SttProvider> = {
  openai: { defaultModel: "gpt-4o-transcribe", transcribe: openaiTranscribe },
  "openai-compatible": {
    // Generic Whisper id for Groq/self-hosted endpoints (gpt-4o-transcribe is OpenAI-only).
    defaultModel: "whisper-1",
    requiresBaseURL: true,
    transcribe: openaiTranscribe,
  },
  gemini: { defaultModel: "gemini-3.5-flash", transcribe: geminiTranscribe },
  elevenlabs: { defaultModel: "scribe_v2", transcribe: elevenlabsTranscribe },
  openrouter: {
    defaultModel: "openai/whisper-1",
    transcribe: openrouterTranscribe,
  },
  assemblyai: {
    defaultModel: "universal-3-5-pro",
    transcribe: makeAssemblyaiTranscribe({
      budgetMs: STT_TIMEOUT_MS,
      pollDelaysMs: [500, 1_000, 1_500, 2_000, 3_000],
    }),
  },
};

// FROZEN because it is exported and shared: `sort`, `push` and friends mutate in place, so one
// caller tidying this list reorders it for every other holder in the process. A test did exactly
// that (`STT_PROVIDER_NAMES.sort()`), and the damage landed in an unrelated file that
// compares the published MCP enum against this array. Frozen, that write throws where it is made.
export const STT_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function getSttProvider(name: string): SttProvider | null {
  return PROVIDERS[name] ?? null;
}
