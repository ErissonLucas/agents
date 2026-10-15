import { getDocumentProxy } from "unpdf";
import { clipText } from "@/lib/text";

// A PDF's TEXT LAYER, read here without any provider (`settings.vision.pdfText`, docs/stt.md).
// It is what answers a PDF on an endpoint that cannot take one (`document_not_supported`): a nota
// fiscal or a boleto is generated text, and reading it costs no call and no spend. A scan has no
// text layer, and the model is told so in words that make it ask for photos instead.
//
// Same library as the knowledge-base loader (../rag/loaders.ts), so nothing new ships in the image.

export const PDF_TEXT_MAX_PAGES = 10;
export const PDF_TEXT_MAX_CHARS = 12_000;
export const PDF_TEXT_TIMEOUT_MS = 15_000;

export interface PdfText {
  text: string;
  pages: number;
  pagesRead: number;
  // The text went past PDF_TEXT_MAX_CHARS and was cut.
  clipped: boolean;
}

// unpdf's own merge (`normalizeMergedText`): whitespace collapsed, line breaks kept, at most one
// blank line in a row.
function normalize(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pages read in order and stopped at whichever cap comes first. The proxy is OURS here, so it is
// destroyed here, as unpdf's own `withDocument` does (see the ownership note in ../rag/loaders.ts).
// The timeout only stops waiting: a parse that outlives it ends at the next page boundary and
// releases the document then.
export async function readPdfText(
  bytes: ArrayBuffer,
  opts: { maxPages?: number; maxChars?: number; timeoutMs?: number } = {},
): Promise<PdfText> {
  const maxPages = opts.maxPages ?? PDF_TEXT_MAX_PAGES;
  const maxChars = opts.maxChars ?? PDF_TEXT_MAX_CHARS;
  let abandoned = false;
  const work = (async () => {
    // A copy: pdf.js may take ownership of the buffer it is handed, and the caller still holds it.
    const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
    try {
      const parts: string[] = [];
      let size = 0;
      let pagesRead = 0;
      for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
        if (abandoned || size > maxChars) break;
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
          )
          .join("");
        parts.push(text);
        size += text.length;
        pagesRead = n;
      }
      const all = normalize(parts.join("\n"));
      return {
        text: clipText(all, maxChars),
        pages: pdf.numPages,
        pagesRead,
        clipped: all.length > maxChars,
      };
    } finally {
      await pdf.loadingTask.destroy().catch(() => {});
    }
  })();
  return withTimeout(work, opts.timeoutMs ?? PDF_TEXT_TIMEOUT_MS, () => {
    abandoned = true;
  });
}

// Stops WAITING for `work` after `ms`; `onTimeout` is how the work learns it was abandoned.
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void = () => {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("pdf text extraction timed out"));
    }, ms);
  });
  // A rejection that lands after the timeout won must not surface as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// What the model reads inside `<documento>` (../chatwoot/render.ts). The caveats come first, so a
// partial read can never pass for the whole document.
export const PDF_SEM_TEXTO =
  "[PDF sem texto legível: parece digitalizado ou feito só de imagens, e o conteúdo não pôde ser lido. Peça fotos nítidas das páginas, ou que a pessoa escreva o que precisa.]";

export function pdfTextForModel(r: PdfText): string {
  if (!r.text) return PDF_SEM_TEXTO;
  const avisos: string[] = [];
  if (r.pagesRead < r.pages)
    avisos.push(
      `lidas só as páginas 1 a ${r.pagesRead} de ${r.pages}; o resto não foi lido`,
    );
  if (r.clipped)
    avisos.push(`texto cortado em ${PDF_TEXT_MAX_CHARS} caracteres`);
  const head = avisos.length ? `[Texto do PDF; ${avisos.join("; ")}.]\n` : "";
  return `${head}${r.text}`;
}
