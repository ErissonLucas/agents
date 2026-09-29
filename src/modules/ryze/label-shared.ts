// WhatsApp Business labels of a RyzeAPI number: the pure half, shared by the server (catalog, sync,
// prompt) and the console (palette, limits, slug). No I/O here.

/** WhatsApp Business allows this many labels per number. */
export const RYZE_LABEL_MAX = 20;
export const RYZE_LABEL_TITLE_MAX = 40;
export const RYZE_LABEL_DESCRIPTION_MAX = 300;

/**
 * WhatsApp Business's label palette by RyzeAPI color index (0..10), approximated. Label colors are
 * data from WhatsApp, not theme colors, which is why they are hex values.
 */
export const RYZE_LABEL_COLORS: readonly string[] = [
  "#ff9485",
  "#64c4ff",
  "#ffd429",
  "#dfaef0",
  "#99b6c1",
  "#55ccb3",
  "#ff9dff",
  "#d3a91d",
  "#6d7cce",
  "#d7e752",
  "#00d0e2",
];

export function ryzeLabelColorHex(color: number): string {
  return RYZE_LABEL_COLORS[color] ?? (RYZE_LABEL_COLORS[0] as string);
}

export function isRyzeLabelColor(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v < RYZE_LABEL_COLORS.length
  );
}

/**
 * What a label does on its own: `clear_on_reply` leaves the conversation when the contact writes,
 * `human_takeover` is on while a person holds the conversation, `new_conversation` marks a chat's
 * first conversation.
 */
export const RYZE_LABEL_AUTO_RULES = [
  "clear_on_reply",
  "human_takeover",
  "new_conversation",
] as const;
export type RyzeLabelAutoRule = (typeof RYZE_LABEL_AUTO_RULES)[number];

export function isRyzeLabelAutoRule(v: unknown): v is RyzeLabelAutoRule {
  return (
    typeof v === "string" &&
    (RYZE_LABEL_AUTO_RULES as readonly string[]).includes(v)
  );
}

/** The internal title for a WhatsApp name: lowercase, accents stripped, spaces as "-". */
export function labelSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, RYZE_LABEL_TITLE_MAX);
}

/**
 * The number RyzeAPI tags a chat by: the digits before the @ of a phone JID. Null for a group, and
 * for a lid, whose digits are not a phone number.
 */
export function chatNumber(chatJid: string): string | null {
  const [user, domain] = chatJid.split("@");
  if (domain !== undefined && domain !== "s.whatsapp.net") return null;
  const digits = (user ?? "").replace(/\D/g, "");
  return digits.length > 0 && digits === user ? digits : null;
}

/** Titles added and removed between two label lists (exact titles, each once). */
export function labelDelta(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((t) => !b.has(t)),
    removed: [...b].filter((t) => !a.has(t)),
  };
}

export function sameLabelTitle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The system-prompt block for a Ryze conversation, or null when no catalog label says when to use
 * it. `deviceLabels` are the titles the team moved on the phone, which the agent must not touch.
 */
export function ryzeLabelPromptSection(
  catalog: readonly { title: string; description: string | null }[],
  deviceLabels: readonly string[],
): string | null {
  const described = catalog.filter(
    (l) => l.description && l.description.trim().length > 0,
  );
  if (described.length === 0) return null;
  const lines = [
    "## Etiquetas do WhatsApp",
    "Mantenha as etiquetas desta conversa atualizadas com a ferramenta set_labels. Etiquetas do catálogo e quando usar cada uma:",
    ...described.map(
      (l) => `- ${l.title}: ${(l.description as string).trim()}`,
    ),
    'Etiquetas de etapa (aquelas cuja descrição acima começa com "Etapa:") valem uma por vez: ao mover a conversa para uma nova etapa, remova a etiqueta da etapa anterior na mesma chamada.',
  ];
  if (deviceLabels.length > 0) {
    lines.push(
      `Nunca altere as etiquetas que a equipe mudou pelo celular: ${deviceLabels.join(", ")}.`,
    );
  }
  return lines.join("\n");
}
