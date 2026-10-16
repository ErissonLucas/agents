import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl as defaultAssertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readProviderJson } from "@/modules/models/provider-listing";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import {
  FISH_MODELS,
  GEMINI_MODELS,
  GEMINI_VOICES,
  looksLikeFishVoiceId,
  OPENAI_MODELS,
  OPENAI_VOICES,
  OPENROUTER_MODELS,
  OPENROUTER_VOICES,
} from "./catalog";
import { TTS_PROVIDER_NAMES } from "./providers";

// Lists the voices / models the editor's TTS combobox offers (item 10). OpenAI has no list endpoint
// for its named voices/speech models, so we serve a curated set (the combobox's "use custom" covers
// anything newer). ElevenLabs and Fish Audio voices are per-account, so we fetch them live with the
// tenant's vault key — the operator picks from their real voices instead of guessing a voice_id.

export interface TtsListItem {
  id: string;
  label?: string;
}

export type TtsListKind = "voices" | "models";

// The curated lists live in ./catalog: the save boundary judges a voice or model against them too.

const FISH_PAGE_SIZE = 50;

async function resolveApiKey(
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
): Promise<string | null> {
  const entry = await runScopedOn(base, ctx, (db) =>
    tryResolveApiKeyEntry(db, credentialRef),
  );
  // One null for three states, and that is right here: the picker's job is to list what it can, and
  // an unusable credential produces the same empty list as a missing one. The `state` split exists
  // for the runtime paths, where the operator needs the reason in a log line (issue #471).
  return entry.state === "ok" ? entry.secret : null;
}

export type KeyResolver = (
  base: PrismaClient,
  ctx: TenantContext,
  credentialRef: string,
) => Promise<string | null>;

export async function listTtsOptions(
  ctx: TenantContext,
  input: {
    provider: string;
    kind: TtsListKind;
    credentialRef?: string;
    baseURL?: string;
    // Fish voices only: a name to search for, or a voice id to look up. Ignored elsewhere, where the
    // whole list is local and the combobox filters it.
    search?: string;
  },
  base: PrismaClient = basePrisma,
  fetchFn: typeof fetch = fetch,
  assertSafe: typeof defaultAssertSafeOutboundUrl = defaultAssertSafeOutboundUrl,
  resolveKey: KeyResolver = resolveApiKey,
): Promise<TtsListItem[]> {
  const { provider, kind, credentialRef, baseURL, search } = input;

  if (!TTS_PROVIDER_NAMES.includes(provider)) {
    throw new AppError(
      `unknown tts provider: ${provider}`,
      400,
      "errors.unknownProvider",
      { capability: "tts", provider },
    );
  }

  // OpenAI: curated (no list endpoint for named voices / speech models), no credential needed.
  if (provider === "openai") {
    return (kind === "voices" ? OPENAI_VOICES : OPENAI_MODELS).map((id) => ({
      id,
    }));
  }

  // OpenRouter: also curated (no list endpoint for named voices / speech models), no credential
  // needed.
  if (provider === "openrouter") {
    return (kind === "voices" ? OPENROUTER_VOICES : OPENROUTER_MODELS).map(
      (id) => ({ id }),
    );
  }

  if (provider === "gemini") {
    return (kind === "voices" ? GEMINI_VOICES : GEMINI_MODELS).map((id) => ({
      id,
    }));
  }

  if (provider === "fish" && kind === "models") {
    return FISH_MODELS.map((id) => ({ id }));
  }

  if (provider !== "elevenlabs" && provider !== "fish") return [];

  if (!credentialRef) {
    throw new AppError(
      "A credential is required to list provider models.",
      400,
      "errors.credentialRequired",
    );
  }
  const apiKey = await resolveKey(base, ctx, credentialRef);
  if (!apiKey) {
    // NOTE: the sentence names three possibilities and picks none, because the resolver returns
    // `null` for all three (the ref points at nothing, the entry holds no secret, or the entry is a
    // multi-field/managed credential whose secret is an object rather than an API key) and this
    // code learns nothing else. Naming one of them would be inventing a cause nobody measured,
    // which is the defect issue #292 exists to remove — one layer down. Telling them apart means
    // reading the entry back on the failure path, and that is a behaviour change, not a wording one.
    throw new AppError(
      "credential did not resolve to an API key",
      400,
      "errors.credentialNotUsable",
    );
  }

  if (provider === "fish") {
    return listFishVoices(apiKey, baseURL, search, fetchFn, assertSafe);
  }

  const root = (baseURL ?? "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
  const safeUrl = await assertSafe(`${root}/${kind}`, { allowHttp: true });
  try {
    const res = await fetchFn(safeUrl.toString(), {
      headers: { "xi-api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new AppError(
        `ElevenLabs ${kind} endpoint returned ${res.status}`,
        502,
        "errors.providerModelsFailed",
        { provider, status: res.status },
      );
    }
    const json = await readProviderJson(res, provider);
    if (kind === "voices") {
      const voices = (json as { voices?: unknown[] }).voices;
      if (!Array.isArray(voices)) {
        throw new AppError(
          "unexpected ElevenLabs voices response",
          502,
          "errors.providerListUnexpectedResponse",
          { provider },
        );
      }
      return voices
        .map((v) => v as { voice_id?: unknown; name?: unknown } | null)
        .map((v) => ({
          id: typeof v?.voice_id === "string" ? v.voice_id : "",
          label: typeof v?.name === "string" ? v.name : undefined,
        }))
        .filter((v) => v.id.length > 0);
    }
    // models: a bare array of { model_id, name, can_do_text_to_speech }.
    const arr = Array.isArray(json)
      ? json
      : (json as { models?: unknown[] }).models;
    if (!Array.isArray(arr)) {
      throw new AppError(
        "unexpected ElevenLabs models response",
        502,
        "errors.providerListUnexpectedResponse",
        { provider },
      );
    }
    return arr
      .map(
        (m) =>
          m as {
            model_id?: unknown;
            name?: unknown;
            can_do_text_to_speech?: unknown;
          } | null,
      )
      .filter((m) => m?.can_do_text_to_speech !== false)
      .map((m) => ({
        id: typeof m?.model_id === "string" ? m.model_id : "",
        label: typeof m?.name === "string" ? m.name : undefined,
      }))
      .filter((m) => m.id.length > 0);
  } catch (e) {
    if (e instanceof AppError) throw e;
    // NOTE: the sentence carries the PROVIDER and not the error text. A failure to reach a host is
    // raised by the client with the request in hand, and Bun's header validation puts the offending
    // header VALUE in the message it throws — measured: `Header 'Authorization' has invalid value:
    // 'Bearer <the vault secret>'`. Interpolating that would answer a write-only credential back to
    // whoever called the listing endpoint. The text stays in `message`, which is the log line, and
    // the catalog entry has no placeholder for it (found by review, issue #292).
    throw new AppError(
      `failed to list ElevenLabs ${kind}: ${e instanceof Error ? e.message : String(e)}`,
      502,
      "errors.providerListUnreachable",
      { provider },
    );
  }
}

// One page of GET /model. Fish's API root has no /v1 (the TTS route does), so a custom baseURL is
// read as the TTS one and its trailing /v1 dropped. A voice still training, or a non-TTS model
// (`svc`), is not one the agent can speak with, so it is not offered.
function fishVoiceOf(raw: unknown): TtsListItem | null {
  const v = (raw ?? {}) as {
    _id?: unknown;
    title?: unknown;
    type?: unknown;
    state?: unknown;
  };
  if (v.type === "svc" || (v.state && v.state !== "trained")) return null;
  if (typeof v._id !== "string" || v._id.length === 0) return null;
  return {
    id: v._id,
    label: typeof v.title === "string" ? v.title : undefined,
  };
}

async function fishGet(
  url: URL,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<Response> {
  return fetchFn(url.toString(), {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

function fishRefused(status: number): AppError {
  return new AppError(
    `Fish Audio voices endpoint returned ${status}`,
    502,
    "errors.providerModelsFailed",
    { provider: "fish", status },
  );
}

async function fishVoicePage(
  url: URL,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<TtsListItem[]> {
  const res = await fishGet(url, apiKey, fetchFn);
  if (!res.ok) throw fishRefused(res.status);
  const items = ((await readProviderJson(res, "fish")) as { items?: unknown })
    .items;
  if (!Array.isArray(items)) {
    throw new AppError(
      "unexpected Fish Audio voices response",
      502,
      "errors.providerListUnexpectedResponse",
      { provider: "fish" },
    );
  }
  return items.map(fishVoiceOf).filter((v): v is TtsListItem => v !== null);
}

// GET /model/{id}: the one voice, or none when Fish does not know the id (404, or 400/422 for an id
// it cannot parse). An empty list is the answer the editor turns into "voice not found".
async function fishVoiceById(
  root: string,
  id: string,
  apiKey: string,
  fetchFn: typeof fetch,
  assertSafe: typeof defaultAssertSafeOutboundUrl,
): Promise<TtsListItem[]> {
  const url = await assertSafe(`${root}/model/${id}`, { allowHttp: true });
  const res = await fishGet(url, apiKey, fetchFn);
  if (res.status === 404 || res.status === 400 || res.status === 422) {
    return [];
  }
  if (!res.ok) throw fishRefused(res.status);
  const voice = fishVoiceOf(await readProviderJson(res, "fish"));
  return voice ? [voice] : [];
}

// Without a search: the account's voices, then the most used public Portuguese ones. With a name:
// the account's matches, then public ones in Portuguese, then public ones in any language, so a
// Portuguese voice comes first but a search for an English one still finds it. With a voice id:
// that one voice, looked up directly.
async function listFishVoices(
  apiKey: string,
  baseURL: string | undefined,
  search: string | undefined,
  fetchFn: typeof fetch,
  assertSafe: typeof defaultAssertSafeOutboundUrl,
): Promise<TtsListItem[]> {
  const root = (baseURL ?? "https://api.fish.audio")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  const term = search?.trim() ?? "";
  const page = `page_size=${FISH_PAGE_SIZE}`;
  const title = `title=${encodeURIComponent(term)}`;
  const query = term
    ? [
        `self=true&${title}&${page}&sort_by=created_at`,
        `${title}&language=pt&${page}&sort_by=task_count`,
        `${title}&${page}&sort_by=task_count`,
      ]
    : [
        `self=true&${page}&sort_by=created_at`,
        `language=pt&${page}&sort_by=task_count`,
      ];
  try {
    if (looksLikeFishVoiceId(term)) {
      return await fishVoiceById(
        root,
        term.toLowerCase(),
        apiKey,
        fetchFn,
        assertSafe,
      );
    }
    const out: TtsListItem[] = [];
    const seen = new Set<string>();
    for (const q of query) {
      const url = await assertSafe(`${root}/model?${q}`, { allowHttp: true });
      for (const v of await fishVoicePage(url, apiKey, fetchFn)) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push(v);
      }
    }
    return out;
  } catch (e) {
    if (e instanceof AppError) throw e;
    // NOTE: the provider, not the error text, goes to the caller, as on the ElevenLabs path above.
    throw new AppError(
      `failed to list Fish Audio voices: ${e instanceof Error ? e.message : String(e)}`,
      502,
      "errors.providerListUnreachable",
      { provider: "fish" },
    );
  }
}
