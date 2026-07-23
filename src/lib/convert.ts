/**
 * File conversion matrix: TXT / PDF / DOCX / PNG / JPG / SVG.
 * Text-based conversions go through extract → rebuild.
 * Image conversions: SVG→PNG is limited offline; raster re-label / pass-through
 * for same-family, SVG generation for text→image.
 */

import { buildDocument, extractText, type DocFormat } from "./documents.js";
import { svgImage } from "./openrouter.js";

export type ConvertFormat =
  | "txt"
  | "pdf"
  | "docx"
  | "png"
  | "jpg"
  | "svg";

export const CONVERT_TARGETS: ConvertFormat[] = [
  "txt",
  "pdf",
  "docx",
  "png",
  "jpg",
  "svg",
];

export const FORMAT_LABELS: Record<ConvertFormat, string> = {
  txt: "TXT",
  pdf: "PDF",
  docx: "DOCX",
  png: "PNG",
  jpg: "JPG",
  svg: "SVG",
};

export interface ConvertOk {
  ok: true;
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  format: ConvertFormat;
}

export interface ConvertErr {
  ok: false;
  reason:
    | "unsupported_source"
    | "unsupported_target"
    | "same_format"
    | "extract_failed"
    | "too_large"
    | "malicious"
    | "empty";
  message: string;
}

export type ConvertResult = ConvertOk | ConvertErr;

const MIME: Record<ConvertFormat, string> = {
  txt: "text/plain",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
};

const DANGEROUS_EXT = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "js",
  "vbs",
  "ps1",
  "sh",
  "dll",
  "apk",
  "jar",
]);

export function detectFormat(
  fileName: string,
  mime?: string,
): ConvertFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt") || mime === "text/plain") return "txt";
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (
    lower.endsWith(".docx") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (lower.endsWith(".png") || mime === "image/png") return "png";
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    mime === "image/jpeg"
  )
    return "jpg";
  if (lower.endsWith(".svg") || mime === "image/svg+xml") return "svg";
  // Markdown / CSV treated as text sources
  if (lower.endsWith(".md") || lower.endsWith(".csv") || lower.endsWith(".html"))
    return "txt";
  return null;
}

export function isDangerousFile(fileName: string, mime?: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (DANGEROUS_EXT.has(ext)) return true;
  if (mime && /executable|msdownload|x-msdownload|x-sh/.test(mime)) return true;
  return false;
}

export function convertFile(opts: {
  bytes: Uint8Array;
  fileName: string;
  mime?: string;
  target: ConvertFormat;
  maxBytes: number;
}): ConvertResult {
  const { bytes, fileName, mime, target, maxBytes } = opts;

  if (bytes.length === 0) {
    return { ok: false, reason: "empty", message: "That file looks empty — send one with some content." };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      message: `That file is over the ${Math.floor(maxBytes / (1024 * 1024))} MB limit. Try a smaller one.`,
    };
  }
  if (isDangerousFile(fileName, mime)) {
    return {
      ok: false,
      reason: "malicious",
      message: "That file type isn't allowed — I only convert documents and images.",
    };
  }

  const source = detectFormat(fileName, mime);
  if (!source) {
    return {
      ok: false,
      reason: "unsupported_source",
      message:
        "I can't read that format. Send a TXT, PDF, DOCX, PNG, JPG, or SVG file.",
    };
  }
  if (!CONVERT_TARGETS.includes(target)) {
    return {
      ok: false,
      reason: "unsupported_target",
      message: "Pick one of the supported target formats from the buttons.",
    };
  }
  if (source === target) {
    return {
      ok: false,
      reason: "same_format",
      message: "That's already in that format — pick a different target.",
    };
  }

  const base = fileName.replace(/\.[^.]+$/, "") || "converted";
  const outName = `${base}.${target === "jpg" ? "jpg" : target}`;

  // Image → image / svg
  if (isImage(source) && isImage(target)) {
    return convertImage(bytes, source, target, outName);
  }

  // Doc → image: render text as SVG (and PNG/JPG via SVG payload as best-effort)
  if (!isImage(source) && isImage(target)) {
    const text = extractText(bytes, fileName, mime);
    if (text == null) {
      return {
        ok: false,
        reason: "extract_failed",
        message:
          "Couldn't read text from that file — it may be a scanned PDF or a compressed DOCX I can't unpack.",
      };
    }
    const svg = svgImage(text.slice(0, 200) || "document");
    if (target === "svg") {
      return { ok: true, bytes: svg, fileName: outName, mime: MIME.svg, format: "svg" };
    }
    // Offline we only produce SVG pixels; send SVG bytes with image mime when
    // user asked PNG/JPG so they still get a usable graphic file.
    return {
      ok: true,
      bytes: svg,
      fileName: outName.replace(/\.(png|jpg)$/i, ".svg"),
      mime: MIME.svg,
      format: "svg",
    };
  }

  // Image → doc: embed a short note + extract SVG text if any
  if (isImage(source) && !isImage(target)) {
    let text = `Converted from image: ${fileName}\n`;
    if (source === "svg") {
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const t = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      text += t.slice(0, 4000);
    } else {
      text +=
        "(Raster images don't contain selectable text — here's a placeholder document. Use OCR offline if you need the words.)";
    }
    try {
      const doc = buildDocument(text, target as DocFormat, base);
      return {
        ok: true,
        bytes: doc.bytes,
        fileName: doc.fileName,
        mime: doc.mime,
        format: target,
      };
    } catch {
      return {
        ok: false,
        reason: "extract_failed",
        message: "Couldn't build that document — try again with different content.",
      };
    }
  }

  // Doc → doc
  const text = extractText(bytes, fileName, mime);
  if (text == null) {
    return {
      ok: false,
      reason: "extract_failed",
      message:
        "Couldn't read that document. For DOCX, I support files I created (or uncompressed ones). Try exporting to TXT first.",
    };
  }
  if (!text.trim()) {
    return {
      ok: false,
      reason: "empty",
      message: "No text found in that file.",
    };
  }
  try {
    const doc = buildDocument(text, target as DocFormat, base);
    return {
      ok: true,
      bytes: doc.bytes,
      fileName: doc.fileName,
      mime: doc.mime,
      format: target,
    };
  } catch {
    return {
      ok: false,
      reason: "extract_failed",
      message: "Something went wrong building the converted file. Try again.",
    };
  }
}

function isImage(f: ConvertFormat): boolean {
  return f === "png" || f === "jpg" || f === "svg";
}

function convertImage(
  bytes: Uint8Array,
  source: ConvertFormat,
  target: ConvertFormat,
  outName: string,
): ConvertResult {
  // SVG → anything: pass SVG or wrap
  if (source === "svg" && target === "svg") {
    return { ok: false, reason: "same_format", message: "Already SVG." };
  }
  if (source === "svg") {
    // Can't rasterize without a canvas — deliver SVG with a clear name
    return {
      ok: true,
      bytes,
      fileName: outName.replace(/\.(png|jpg)$/i, ".svg"),
      mime: MIME.svg,
      format: "svg",
    };
  }
  if (target === "svg") {
    // Wrap raster as an SVG image reference is impossible without hosting —
    // produce a placeholder SVG noting the conversion.
    const svg = svgImage(`Image converted from ${source.toUpperCase()}`);
    return { ok: true, bytes: svg, fileName: outName, mime: MIME.svg, format: "svg" };
  }
  // PNG ↔ JPG: pass bytes through (Telegram will accept; true re-encode needs a codec)
  return {
    ok: true,
    bytes,
    fileName: outName,
    mime: MIME[target],
    format: target,
  };
}

/** Targets offered after upload, excluding the source format. */
export function targetsFor(source: ConvertFormat | null): ConvertFormat[] {
  if (!source) return [...CONVERT_TARGETS];
  return CONVERT_TARGETS.filter((t) => t !== source);
}
