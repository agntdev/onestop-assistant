/**
 * Pure-TS document generators (TXT / PDF / DOCX). No Node-only packages —
 * safe for Cloudflare Workers.
 */

export type DocFormat = "txt" | "pdf" | "docx";

export interface BuiltDoc {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  format: DocFormat;
}

const MIME: Record<DocFormat, string> = {
  txt: "text/plain",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function buildDocument(
  content: string,
  format: DocFormat,
  title = "document",
): BuiltDoc {
  const body = content.trim();
  if (!body) throw new Error("empty_content");

  const safeTitle = slug(title) || "document";
  if (format === "txt") {
    const bytes = new TextEncoder().encode(body + "\n");
    return { bytes, fileName: `${safeTitle}.txt`, mime: MIME.txt, format };
  }
  if (format === "pdf") {
    const bytes = buildPdf(body);
    return { bytes, fileName: `${safeTitle}.pdf`, mime: MIME.pdf, format };
  }
  const bytes = buildDocx(body, title);
  return { bytes, fileName: `${safeTitle}.docx`, mime: MIME.docx, format };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Minimal single-page PDF with Helvetica text (ASCII-safe wrapping). */
export function buildPdf(text: string): Uint8Array {
  const lines = wrapText(text, 80).slice(0, 60);
  const escaped = lines.map(pdfEscape);
  const contentLines = ["BT", "/F1 12 Tf", "50 780 Td", "14 TL"];
  escaped.forEach((line, i) => {
    if (i === 0) contentLines.push(`(${line}) Tj`);
    else contentLines.push(`T* (${line}) Tj`);
  });
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const streamBytes = new TextEncoder().encode(stream);

  const objs: string[] = [];
  objs.push("1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n");
  objs.push("2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n");
  objs.push(
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n",
  );
  objs.push(
    `4 0 obj<< /Length ${streamBytes.length} >>stream\n${stream}\nendstream\nendobj\n`,
  );
  objs.push("5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function pdfEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      if (!line) line = w;
      else if ((line + " " + w).length <= width) line += " " + w;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

/**
 * Minimal DOCX (ZIP of OOXML parts). Implemented with a pure-JS STORED zip
 * (no compression) so we need no Node or third-party zip library.
 */
export function buildDocx(text: string, title = "Document"): Uint8Array {
  const paragraphs = text.split(/\r?\n/).map((line) => {
    const t = xmlEscape(line);
    return `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  });
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraphs.join("")}<w:sectPr/></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<dc:creator>OneStop Assistant</dc:creator>` +
    `</cp:coreProperties>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: documentXml },
    { name: "docProps/core.xml", data: core },
  ]);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // method = store
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    parts.push(local);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total =
    parts.reduce((n, p) => n + p.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  for (const c of central) {
    out.set(c, o);
    o += c.length;
  }
  out.set(end, o);
  return out;
}

/** CRC-32 (ZIP). */
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Extract plain text from a TXT / simple PDF / DOCX buffer (best-effort). */
export function extractText(
  bytes: Uint8Array,
  fileName: string,
  mime?: string,
): string | null {
  const lower = fileName.toLowerCase();
  const isTxt =
    lower.endsWith(".txt") ||
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime === "text/csv";
  if (isTxt) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    return extractPdfText(bytes);
  }
  if (
    lower.endsWith(".docx") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxText(bytes);
  }
  return null;
}

function extractPdfText(bytes: Uint8Array): string | null {
  const raw = new TextDecoder("latin1").decode(bytes);
  if (!raw.startsWith("%PDF")) return null;
  const matches = [...raw.matchAll(/\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g)];
  if (matches.length === 0) {
    // Fallback: pull printable streams
    const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
    const chunks: string[] = [];
    for (const m of streams) {
      const body = m[1] ?? "";
      const tj = [...body.matchAll(/\(([^)]*)\)/g)].map((x) => x[1] ?? "");
      chunks.push(...tj);
    }
    const text = chunks.join("\n").replace(/\\n/g, "\n").trim();
    return text || null;
  }
  return matches
    .map((m) => (m[1] ?? "").replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"))
    .join("\n")
    .trim();
}

function extractDocxText(bytes: Uint8Array): string | null {
  // Find word/document.xml inside the zip (stored or deflated). We only support
  // STORED entries (what we write). Deflated third-party files → unsupported.
  const name = "word/document.xml";
  const nameBytes = new TextEncoder().encode(name);
  for (let i = 0; i < bytes.length - 30; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 30);
      const method = view.getUint16(8, true);
      const compSize = view.getUint32(18, true);
      const nameLen = view.getUint16(26, true);
      const extraLen = view.getUint16(28, true);
      const nameStart = i + 30;
      const entryName = new TextDecoder().decode(
        bytes.subarray(nameStart, nameStart + nameLen),
      );
      if (entryName !== name) continue;
      if (method !== 0) return null; // deflated — can't inflate without a lib
      const dataStart = nameStart + nameLen + extraLen;
      const xml = new TextDecoder().decode(
        bytes.subarray(dataStart, dataStart + compSize),
      );
      const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(
        (m) => m[1] ?? "",
      );
      return texts.join("\n").trim() || null;
    }
  }
  return null;
}
