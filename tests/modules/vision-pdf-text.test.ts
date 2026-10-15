import { describe, expect, test } from "bun:test";
import {
  PDF_SEM_TEXTO,
  PDF_TEXT_MAX_CHARS,
  pdfTextForModel,
  readPdfText,
  withTimeout,
} from "@/modules/vision/pdf-text";
import { readVisionConfig } from "@/modules/vision/settings";
import { tinyPdf } from "@/tests/utils/tiny-pdf";

// The local read of a PDF's text layer (src/modules/vision/pdf-text.ts), on real bytes built in
// the test: a generated nota fiscal reads as text, and a scan reads as "nothing legible".

describe("PDF text layer", () => {
  test("a PDF with text is read page by page", async () => {
    const r = await readPdfText(
      tinyPdf(["NF-e 123 Batom Mary Kay R$ 59,90", "Total R$ 59,90"]),
    );
    expect(r).toEqual({
      text: "NF-e 123 Batom Mary Kay R$ 59,90\nTotal R$ 59,90",
      pages: 2,
      pagesRead: 2,
      clipped: false,
    });
    expect(pdfTextForModel(r)).toBe(r.text);
  });

  test("a PDF with no text layer tells the model to ask for photos", async () => {
    const r = await readPdfText(tinyPdf([null, null]));
    expect(r.text).toBe("");
    expect(pdfTextForModel(r)).toBe(PDF_SEM_TEXTO);
    expect(PDF_SEM_TEXTO).toContain("fotos");
  });

  test("past the page cap, the model is told what was not read", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `pagina ${i + 1}`);
    const r = await readPdfText(tinyPdf(pages));
    expect(r.pages).toBe(12);
    expect(r.pagesRead).toBe(10);
    expect(r.text).not.toContain("pagina 11");
    expect(pdfTextForModel(r)).toStartWith(
      "[Texto do PDF; lidas só as páginas 1 a 10 de 12; o resto não foi lido.]\n",
    );
  });

  test("past the character cap, the text is cut and says so", async () => {
    const pages = Array.from({ length: 8 }, () => "abcde fghij ".repeat(5));
    const r = await readPdfText(tinyPdf(pages), { maxChars: 300 });
    expect(r.text.length).toBe(300);
    expect(r.clipped).toBe(true);
    expect(pdfTextForModel(r)).toContain(
      `texto cortado em ${PDF_TEXT_MAX_CHARS} caracteres`,
    );
  });

  test("bytes that are not a PDF throw, and a slow read times out", async () => {
    await expect(readPdfText(new ArrayBuffer(16))).rejects.toThrow();
    let abandoned = false;
    await expect(
      withTimeout(new Promise(() => {}), 5, () => {
        abandoned = true;
      }),
    ).rejects.toThrow("timed out");
    expect(abandoned).toBe(true);
  });

  test("the setting is on unless explicitly false", () => {
    expect(readVisionConfig(undefined).pdfText).toBe(true);
    expect(readVisionConfig({ vision: { enabled: true } }).pdfText).toBe(true);
    expect(readVisionConfig({ vision: { pdfText: false } }).pdfText).toBe(
      false,
    );
  });
});
