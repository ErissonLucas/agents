// Speech-to-text provider abstraction. The OpenAI `/audio/transcriptions` multipart shape is a
// de-facto standard (Groq and most self-hosted Whisper servers implement it), so `openai` and
// `openai-compatible` share one adapter (baseURL switch). Gemini and ElevenLabs have their own
// shapes, so each gets a thin adapter (Fish Audio too); AssemblyAI is asynchronous (upload, submit,
// poll). Adding a provider = one function + one registry entry; a future generic/declarative
// provider can slot in behind the same interface without touching callers.

const STT_TIMEOUT_MS = 60_000;

export interface SttRequest {
  audio: ArrayBuffer;
  mimeType: string | null;
  language: string;
  model: string; // already resolved (provider default applied by the caller)
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
  // The caller's deadline, on top of the provider timeout: a caller with a budget of its own (the
  // snoozed reminder's media reads) stops a transcription that would outlast it.
  signal?: AbortSignal;
}

// What the provider's own confidence said about the text, for the providers that report one, and
// whether it withheld the text: silence and noise come back as fluent text in any language and
// script, and the confidence is what tells them apart (docs/stt.md has the measurement).
export type SttConfidence =
  | { signal: "token_logprob" | "word_logprob"; meanLogprob: number }
  | { signal: "segments"; segments: number; droppedSegments: number };

export interface SttResult {
  text: string;
  confidence?: SttConfidence;
  // None of the text is the customer's; `text` is empty.
  withheld?: true;
}

export interface SttProvider {
  defaultModel: string;
  // openai-compatible requires an explicit baseURL (no public default endpoint).
  requiresBaseURL?: boolean;
  transcribe(req: SttRequest): Promise<SttResult>;
}

function sttSignal(req: SttRequest): AbortSignal {
  const own = AbortSignal.timeout(STT_TIMEOUT_MS);
  return req.signal ? AbortSignal.any([own, req.signal]) : own;
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

// Below these the text is not taken as speech. Measured live (docs/stt.md): on gpt-4o-transcribe,
// silence, noise and speech buried under noise averaged -1.39 or lower per token, clear speech -0.16
// or higher; on Whisper, a segment of silence or noise reported a no-speech probability of 0.82 or
// more, speech 0.69 or less. Scribe's word logprobs share the first floor: clear speech averaged
// -0.65 or higher there, and speech buried under noise came back as fluent text between -0.46 and
// -1.19, so on Scribe the floor catches only part of that.
const MIN_MEAN_TOKEN_LOGPROB = -1.0;
const MAX_SEGMENT_NO_SPEECH_PROB = 0.7;
const MIN_SEGMENT_AVG_LOGPROB = -1.0;

// The confidence each model family can report through the OpenAI shape: gpt-4o transcription models
// return token logprobs on request, Whisper models per-segment probabilities in `verbose_json`. Any
// other model is asked exactly as before, since a server may not know either parameter.
function confidenceShapeFor(model: string): "logprobs" | "segments" | null {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-4o") && m.includes("transcribe")) return "logprobs";
  if (m.includes("whisper")) return "segments";
  return null;
}

interface OpenAiTranscription {
  text?: string;
  logprobs?: Array<{ logprob?: number }>;
  segments?: Array<{
    text?: string;
    no_speech_prob?: number;
    avg_logprob?: number;
  }>;
}

function judgeTranscription(json: OpenAiTranscription): SttResult {
  const text = (json.text ?? "").trim();
  const lps = (json.logprobs ?? [])
    .map((t) => t.logprob)
    .filter((lp): lp is number => typeof lp === "number");
  if (lps.length > 0) {
    const mean = lps.reduce((a, b) => a + b, 0) / lps.length;
    const confidence: SttConfidence = {
      signal: "token_logprob",
      meanLogprob: Math.round(mean * 100) / 100,
    };
    if (mean < MIN_MEAN_TOKEN_LOGPROB) {
      return { text: "", confidence, withheld: true };
    }
    return { text, confidence };
  }
  const segments = json.segments ?? [];
  if (segments.length === 0) return { text };
  const spoken = segments.filter(
    (s) =>
      !(
        (s.no_speech_prob ?? 0) > MAX_SEGMENT_NO_SPEECH_PROB ||
        (s.avg_logprob ?? 0) < MIN_SEGMENT_AVG_LOGPROB
      ),
  );
  const confidence: SttConfidence = {
    signal: "segments",
    segments: segments.length,
    droppedSegments: segments.length - spoken.length,
  };
  // Nothing dropped: the provider's own text, which carries its spacing. A compatible server may trim
  // each segment, so a rebuilt text puts one space between them.
  if (spoken.length === segments.length) return { text, confidence };
  if (spoken.length === 0) return { text: "", confidence, withheld: true };
  return {
    text: spoken
      .map((s) => (s.text ?? "").trim())
      .filter(Boolean)
      .join(" "),
    confidence,
  };
}

// OpenAI Whisper + any OpenAI-compatible endpoint (Groq, self-hosted faster-whisper, …).
async function openaiTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (req.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const post = (shape: "logprobs" | "segments" | null) => {
    const form = new FormData();
    form.append("file", audioBlob(req), fileNameFor(req.mimeType));
    form.append("model", req.model);
    if (req.language) form.append("language", req.language);
    if (shape === "logprobs") {
      form.append("response_format", "json");
      form.append("include[]", "logprobs");
    } else if (shape === "segments") {
      form.append("response_format", "verbose_json");
    }
    return req.fetchImpl(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${req.apiKey}` },
      body: form,
      redirect: "error",
      signal: sttSignal(req),
    });
  };
  const shape = confidenceShapeFor(req.model);
  let res = await post(shape);
  // A compatible server that does not know the confidence parameters may refuse them; the
  // transcription matters more than the confidence, so it is asked again the way it always was.
  if (shape && res.status === 400) res = await post(null);
  if (!res.ok) throw new SttError("openai", res.status);
  return judgeTranscription((await res.json()) as OpenAiTranscription);
}

interface ScribeTranscription {
  text?: string;
  words?: Array<{ type?: string; text?: string; logprob?: number | null }>;
}

// Scribe's transcript, judged. Audio events ("[silêncio]", "[ruído]", "[risos]") are not asked for,
// and any that still come are dropped from the words: none of them is something the customer said,
// and a note with no speech comes back as one alone. The words' mean logprob decides like the OpenAI
// token logprob, under the same floor.
function judgeScribe(json: ScribeTranscription): SttResult {
  const words = json.words ?? [];
  if (words.length === 0) return { text: (json.text ?? "").trim() };
  const text = words
    .filter((w) => w.type !== "audio_event")
    .map((w) => w.text ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const lps = words
    .filter((w) => w.type === "word")
    .map((w) => w.logprob)
    .filter((lp): lp is number => typeof lp === "number");
  if (lps.length === 0) return { text };
  const mean = lps.reduce((a, b) => a + b, 0) / lps.length;
  const confidence: SttConfidence = {
    signal: "word_logprob",
    meanLogprob: Math.round(mean * 100) / 100,
  };
  if (mean < MIN_MEAN_TOKEN_LOGPROB) {
    return { text: "", confidence, withheld: true };
  }
  return { text, confidence };
}

// ElevenLabs Scribe.
async function elevenlabsTranscribe(req: SttRequest): Promise<SttResult> {
  const base = (req.baseURL ?? "https://api.elevenlabs.io/v1").replace(
    /\/+$/,
    "",
  );
  const form = new FormData();
  form.append("file", audioBlob(req), fileNameFor(req.mimeType));
  form.append("model_id", req.model);
  if (req.language) form.append("language_code", req.language);
  form.append("tag_audio_events", "false");
  const res = await req.fetchImpl(`${base}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": req.apiKey },
    body: form,
    redirect: "error",
    signal: sttSignal(req),
  });
  if (!res.ok) throw new SttError("elevenlabs", res.status);
  return judgeScribe((await res.json()) as ScribeTranscription);
}

// Google Gemini: transcription via generateContent with the audio inlined as base64. The key goes in
// the x-goog-api-key header (not the URL) to keep it out of logs.
async function geminiTranscribe(req: SttRequest): Promise<SttResult> {
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
      signal: sttSignal(req),
    },
  );
  if (!res.ok) throw new SttError("gemini", res.status);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
  };
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

async function openrouterTranscribe(req: SttRequest): Promise<SttResult> {
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
    signal: sttSignal(req),
  });
  if (!res.ok) throw new SttError("openrouter", res.status);
  const json = (await res.json()) as { text?: string };
  return { text: (json.text ?? "").trim() };
}

// AssemblyAI: upload the raw bytes, submit a transcript job for the returned URL, then poll the job
// until it settles. Every request of the three steps shares ONE deadline, the same budget the
// single-call adapters get, so a slow queue costs a skipped transcription and never a longer turn.
// A job that ends in `error` is reported by our own slug: its `error` field is provider prose.
export function makeAssemblyaiTranscribe(opts: {
  budgetMs: number;
  pollDelaysMs: readonly number[];
}): (req: SttRequest) => Promise<SttResult> {
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
        return {
          text: (typeof state.text === "string" ? state.text : "").trim(),
        };
      if (state.status === "error")
        throw new SttError("assemblyai", 502, "transcript_error");
    }
  };
}

// Fish Audio: POST /v1/asr, Bearer key, the model in a `model` HEADER, multipart `audio`. It takes an
// ISO 639-1 base code ("pt-BR" can be refused with a 400). The text may carry speaker turns
// (`<|speaker:0|>`) and audio events (`[laughter]`), stripped so the agent reads only the words.
// A 429/5xx is retried once inside the same 60s budget; 401/402 fail with our own slug.
const FISH_ERROR_REASON: Record<number, string> = {
  401: "invalid_api_key",
  402: "insufficient_credit",
  429: "rate_limited",
  503: "overloaded",
};

export function cleanFishTranscript(text: string): string {
  return text
    .replace(/<\|[^|<>]{0,40}\|>/g, " ")
    .replace(/\[[a-z][a-z _-]{0,30}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeFishTranscribe(opts: {
  budgetMs: number;
  retryDelayMs: number;
}): (req: SttRequest) => Promise<SttResult> {
  return async (req) => {
    const base = (req.baseURL ?? "https://api.fish.audio/v1").replace(
      /\/+$/,
      "",
    );
    const deadline = Date.now() + opts.budgetMs;
    const post = () => {
      const form = new FormData();
      form.append("audio", audioBlob(req), fileNameFor(req.mimeType));
      const language = req.language.split("-")[0]?.toLowerCase();
      if (language) form.append("language", language);
      form.append("ignore_timestamps", "true");
      return req.fetchImpl(`${base}/asr`, {
        method: "POST",
        headers: { authorization: `Bearer ${req.apiKey}`, model: req.model },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    };
    let res = await post();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && Date.now() + opts.retryDelayMs < deadline) {
      await res.body?.cancel();
      await Bun.sleep(opts.retryDelayMs);
      res = await post();
    }
    if (!res.ok)
      throw new SttError("fish", res.status, FISH_ERROR_REASON[res.status]);
    const json = (await res.json()) as { text?: unknown };
    return {
      text: cleanFishTranscript(typeof json.text === "string" ? json.text : ""),
    };
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
  fish: {
    defaultModel: "transcribe-1-pro",
    transcribe: makeFishTranscribe({
      budgetMs: STT_TIMEOUT_MS,
      retryDelayMs: 1_000,
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
