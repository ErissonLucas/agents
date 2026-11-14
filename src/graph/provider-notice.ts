// A 200 WHOSE TEXT IS THE PROVIDER TALKING, NOT THE MODEL: a gateway or vendor that answers a
// deprecated client, a retired model or an exhausted quota with a notice in the completion body.
// Delivered as a reply, the customer reads an English service message (and a bot on the other end
// answers it, which turns one notice into a loop). Read as a provider fault instead, it reaches the
// fallback model when there is one and the ordinary failed-turn path when there is not.
//
// Narrow on purpose: whole replies only, short ones only, and only phrasings a provider uses. An
// agent quoting a sentence like these inside a longer answer is not matched.
const NOTICE_MAX_CHARS = 600;

const NOTICE_PATTERNS: readonly RegExp[] = [
  /this version of antigravity is no longer supported/i,
  /download and install the latest version at https?:\/\/antigravity\./i,
  /^\W*(the )?model\b[^.\n]{0,80}\b(is )?no longer (available|supported)\b/i,
  /^\W*(you('ve| have) (hit|reached|exceeded) (your|the) (usage|rate|quota) limit)/i,
  /^\W*(rate limit|quota) (exceeded|reached)\b/i,
];

export class ProviderNoticeFault extends Error {
  constructor() {
    super(PROVIDER_NOTICE_MESSAGE);
    this.name = "ProviderNoticeFault";
  }
}

export const PROVIDER_NOTICE_MESSAGE =
  "the model provider answered with a service notice instead of a completion";

export function isProviderNoticeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NOTICE_MAX_CHARS) return false;
  return NOTICE_PATTERNS.some((re) => re.test(trimmed));
}

function completionText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  const msg = result as { content?: unknown; tool_calls?: unknown[] };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return null;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : typeof part === "string"
            ? part
            : "",
      )
      .join("");
  }
  return null;
}

export function isProviderNotice(result: unknown): boolean {
  const text = completionText(result);
  return text !== null && isProviderNoticeText(text);
}

export function isProviderNoticeFault(err: unknown): boolean {
  return err instanceof ProviderNoticeFault;
}
