// A valid PDF built by hand, for tests that need real bytes without a fixture file: one page per
// entry, each either a line of Helvetica text or (null) a drawn line with no text layer at all,
// which is what a scan looks like to a text extractor.
export function tinyPdf(pages: (string | null)[]): ArrayBuffer {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add("");
  const tree = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const kids: number[] = [];
  for (const text of pages) {
    const ops =
      text === null
        ? "10 10 m 200 200 l S"
        : `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    const content = add(
      `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1, one byte per character, so the offsets above are byte offsets.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes.buffer;
}
