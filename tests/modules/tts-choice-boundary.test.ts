import { describe, expect, test } from "bun:test";
import {
  assertAgentCreatable,
  assertSettingsTtsChoice,
} from "@/modules/agents/service";
import { ttsChoiceIssue } from "@/modules/tts/catalog";

// A voice or model the TTS provider cannot take is refused on save. Measured in the editor: switching
// the provider from Gemini to Fish kept voice "Kore" and model "gemini-2.5-flash-preview-tts", and
// the save would have sent Fish a reference_id "Kore" and a model it does not have.

const FISH_ID = "802e3bc2b27e49c2995d23ef70e6ac89";
// The configuration Vivi runs on in production.
const VIVI = {
  mode: "mirror",
  provider: "gemini",
  voice: "Kore",
  model: "gemini-2.5-flash-preview-tts",
  credentialRef: "vault:7",
};

function refusal(settings: Record<string, unknown>, stored?: unknown) {
  try {
    if (stored === undefined) assertAgentCreatable({ name: "x", settings });
    else assertSettingsTtsChoice(settings, stored);
  } catch (e) {
    return e as { field?: string; statusCode?: number; message: string };
  }
  return null;
}

describe("tts voice/model against the provider", () => {
  test("Vivi's configuration (gemini, Kore, gemini-2.5-flash-preview-tts) saves", () => {
    expect(refusal({ tts: VIVI })).toBeNull();
    expect(refusal({ tts: VIVI }, { tts: VIVI })).toBeNull();
  });

  test("Fish with Gemini's voice is refused, naming tts.voice", () => {
    const err = refusal({ tts: { ...VIVI, provider: "fish", model: "" } });
    expect(err?.statusCode).toBe(400);
    expect(err?.field).toBe("tts.voice");
    expect(err?.message).toContain("Fish Audio voice id");
  });

  test("Fish with a Gemini model is refused, naming tts.model", () => {
    const err = refusal({
      tts: { ...VIVI, provider: "fish", voice: FISH_ID },
    });
    expect(err?.field).toBe("tts.model");
  });

  test("Fish with a reference_id and its own model, or blanks, saves", () => {
    expect(
      refusal({ tts: { provider: "fish", voice: FISH_ID, model: "s2-pro" } }),
    ).toBeNull();
    expect(
      refusal({ tts: { provider: "fish", voice: "", model: "" } }),
    ).toBeNull();
  });

  test("a Fish id on Gemini, or OpenAI's model on Gemini, is refused", () => {
    expect(refusal({ tts: { ...VIVI, voice: FISH_ID } })?.field).toBe(
      "tts.voice",
    );
    expect(refusal({ tts: { ...VIVI, model: "tts-1" } })?.field).toBe(
      "tts.model",
    );
  });

  test("an unknown name is left to the provider; OpenRouter takes any vendor's voice", () => {
    expect(
      ttsChoiceIssue({ provider: "elevenlabs", voice: "Rachel", model: "" }),
    ).toBeNull();
    expect(
      ttsChoiceIssue({
        provider: "openrouter",
        voice: "Kore",
        model: "google/gemini-3.1-flash-tts-preview",
      }),
    ).toBeNull();
    expect(
      ttsChoiceIssue({ provider: "openai", voice: "alloy", model: "" }),
    ).toBeNull();
  });

  test("behind a base URL only the Fish id rule holds", () => {
    expect(
      ttsChoiceIssue({
        provider: "openai",
        voice: "af_bella",
        model: "hexgrad/kokoro-82m",
        baseURL: "https://proxy.example.com/v1",
      }),
    ).toBeNull();
    expect(
      ttsChoiceIssue({
        provider: "fish",
        voice: "Kore",
        model: "",
        baseURL: "https://proxy.example.com/v1",
      })?.field,
    ).toBe("voice");
  });

  test("a stored mismatch re-sent untouched saves; changing it is judged", () => {
    const legacy = { tts: { ...VIVI, provider: "fish" } };
    expect(refusal(legacy, legacy)).toBeNull();
    expect(
      refusal({ tts: { ...legacy.tts, model: "s2-pro" } }, legacy)?.field,
    ).toBe("tts.voice");
  });
});
