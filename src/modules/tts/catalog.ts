// The curated voice/model catalogs of the TTS providers, and the rule that says when a voice or a
// model plainly belongs to ANOTHER provider. No imports on purpose: the editor reads this too (the
// Fish id shape), and the listing and the save boundary must agree on the same lists.

export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];
export const OPENAI_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

// OpenRouter's audio API does expose a live catalog (GET /models?output_modalities=speech, each with
// `supported_voices`), but voices are per model and the listing is not passed the selected one, so
// the set is curated: verified against the real catalog AND a real /audio/speech call (providers.ts
// says why kokoro, not the also-real gemini TTS, is the default). The voices are kokoro's; another
// model needs its own (the combobox's "use custom" covers it).
export const OPENROUTER_VOICES = [
  "af_alloy",
  "af_bella",
  "af_heart",
  "af_nova",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bm_george",
];
export const OPENROUTER_MODELS = [
  "hexgrad/kokoro-82m",
  "google/gemini-3.1-flash-tts-preview",
  "microsoft/mai-voice-2",
  "x-ai/grok-voice-tts-1.0",
  "mistralai/voxtral-mini-tts-2603",
  "sesame/csm-1b",
  "canopylabs/orpheus-3b-0.1-ft",
];

// Gemini's prebuilt voices are one fixed catalog shared by every TTS model, and Google exposes no
// listing endpoint for them, so the set is curated. The models are the ones generateContent serves.
export const GEMINI_VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Aoede",
  "Fenrir",
  "Leda",
  "Orus",
  "Zephyr",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];
export const GEMINI_MODELS = [
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.1-flash-tts-preview",
];

// Fish Audio's TTS models go in the `model` header; `s1` is retired at the end of 2026, so it is not
// offered (but it is still Fish's, for the ownership rule below).
export const FISH_MODELS = ["s2.1-pro", "s2-pro", "s2.1-pro-free", "drama-3"];

// A Fish voice is its `reference_id`: the model's `_id`, 32 lowercase hex characters
// (e.g. 802e3bc2b27e49c2995d23ef70e6ac89, as GET /model lists them).
export const FISH_VOICE_ID_RE = /^[0-9a-f]{32}$/;

export function looksLikeFishVoiceId(value: string): boolean {
  return FISH_VOICE_ID_RE.test(value.trim().toLowerCase());
}

function has(list: readonly string[], value: string): boolean {
  const v = value.toLowerCase();
  return list.some((x) => x.toLowerCase() === v);
}

// Whose model this is, when that is certain: a curated entry, or a vendor's unmistakable prefix on a
// bare id. null = no opinion (a newer model, a custom one), which is never refused.
export function ttsModelOwner(model: string): string | null {
  const m = model.trim();
  if (!m) return null;
  if (has(OPENROUTER_MODELS, m)) return "openrouter";
  if (m.includes("/")) return null;
  if (has(GEMINI_MODELS, m) || /^gemini-/i.test(m)) return "gemini";
  if (has(OPENAI_MODELS, m) || /^(gpt-|tts-1)/i.test(m)) return "openai";
  if (/^eleven_/i.test(m)) return "elevenlabs";
  if (has(FISH_MODELS, m) || m === "s1") return "fish";
  return null;
}

// Whose voice this is, when that is certain. OpenRouter is never named: its models span vendors and
// some of them speak with Gemini's or OpenAI's voices, so no voice is foreign to it.
export function ttsVoiceOwner(voice: string): string | null {
  const v = voice.trim();
  if (!v) return null;
  if (looksLikeFishVoiceId(v)) return "fish";
  if (has(GEMINI_VOICES, v)) return "gemini";
  if (has(OPENAI_VOICES, v)) return "openai";
  if (has(OPENROUTER_VOICES, v)) return "openrouter";
  return null;
}

export type TtsChoiceIssue = { field: "voice" | "model"; value: string };

// The voice or model a provider cannot take. Fish needs a reference_id, so for it any voice that is
// not one is refused. Otherwise only a value that certainly belongs to another provider is: an
// unknown name is left to the provider. Behind a base URL (a proxy that may rename both) only the
// Fish id rule holds. An empty field means the provider's default and is never an issue here.
export function ttsChoiceIssue(cfg: {
  provider: string;
  voice: string;
  model: string;
  baseURL?: string | null;
}): TtsChoiceIssue | null {
  const { provider } = cfg;
  const voice = cfg.voice.trim();
  const model = cfg.model.trim();
  if (provider === "fish" && voice && !FISH_VOICE_ID_RE.test(voice))
    return { field: "voice", value: voice };
  if (cfg.baseURL) return null;
  if (voice) {
    const owner = ttsVoiceOwner(voice);
    const foreign =
      provider === "openrouter"
        ? owner === "fish"
        : owner !== null && owner !== provider;
    if (foreign) return { field: "voice", value: voice };
  }
  if (model) {
    const owner = ttsModelOwner(model);
    if (owner !== null && owner !== provider)
      return { field: "model", value: model };
  }
  return null;
}
