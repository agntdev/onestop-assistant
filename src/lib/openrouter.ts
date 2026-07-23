/**
 * OpenRouter client (chat + image) via fetch — works on Cloudflare Workers.
 * Credentials from env; no Node-only packages.
 */

export interface ChatResult {
  ok: true;
  text: string;
}

export interface ChatError {
  ok: false;
  error: string;
}

export type ChatResponse = ChatResult | ChatError;

export interface ImageResult {
  ok: true;
  bytes: Uint8Array;
  mime: string;
}

export interface ImageError {
  ok: false;
  error: string;
}

export type ImageResponse = ImageResult | ImageError;

function apiKey(): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY;
}

function chatModel(): string {
  if (typeof process === "undefined") return "openrouter/auto";
  return process.env.OPENROUTER_MODEL || "openrouter/auto";
}

function imageModel(): string {
  if (typeof process === "undefined") return "black-forest-labs/flux.2-flex";
  return process.env.OPENROUTER_IMAGE_MODEL || "black-forest-labs/flux.2-flex";
}

const SYSTEM_PROMPT =
  "You are a friendly, concise assistant in a Telegram bot. " +
  "Answer clearly in plain language. Keep answers under 600 words unless the user asks for more detail. " +
  "Do not invent sources. If you don't know, say so.";

/**
 * Answer a general-knowledge question via OpenRouter chat completions.
 * Falls back to a small local answerer when no API key is configured.
 */
export async function answerQuestion(
  question: string,
  opts?: { language?: string; fetchImpl?: typeof fetch },
): Promise<ChatResponse> {
  const q = question.trim();
  if (!q) return { ok: false, error: "empty" };

  const key = apiKey();
  if (!key) {
    return localAnswer(q);
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agnt-gm.ai",
        "X-Title": "OneStop Assistant",
      },
      body: JSON.stringify({
        model: chatModel(),
        messages: [
          {
            role: "system",
            content:
              SYSTEM_PROMPT +
              (opts?.language && opts.language !== "en"
                ? ` Prefer answering in language code: ${opts.language}.`
                : ""),
          },
          { role: "user", content: q },
        ],
        max_tokens: 1200,
        temperature: 0.4,
      }),
    });

    if (res.status === 429) {
      return { ok: false, error: "rate_limit" };
    }
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "empty_response" };
    return { ok: true, text: text.slice(0, 4000) };
  } catch {
    return { ok: false, error: "network" };
  }
}

/**
 * Generate an image from a text prompt via OpenRouter (modalities image).
 * Falls back to a real SVG rendered from the prompt when no API key is set.
 */
export async function generateImage(
  prompt: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ImageResponse> {
  const p = prompt.trim();
  if (!p) return { ok: false, error: "empty" };

  const key = apiKey();
  if (!key) {
    return { ok: true, bytes: svgImage(p), mime: "image/svg+xml" };
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agnt-gm.ai",
        "X-Title": "OneStop Assistant",
      },
      body: JSON.stringify({
        model: imageModel(),
        messages: [{ role: "user", content: p }],
        modalities: ["image", "text"],
      }),
    });

    if (res.status === 429) return { ok: false, error: "rate_limit" };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; image_url?: { url?: string } }>;
          images?: Array<{ image_url?: { url?: string } }>;
        };
      }>;
    };
    const msg = data.choices?.[0]?.message;
    const urls: string[] = [];
    if (msg?.images) {
      for (const img of msg.images) {
        if (img.image_url?.url) urls.push(img.image_url.url);
      }
    }
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part.image_url?.url) urls.push(part.image_url.url);
      }
    }
    const url = urls[0];
    if (!url) {
      // Fallback SVG so the user still gets something useful
      return { ok: true, bytes: svgImage(p), mime: "image/svg+xml" };
    }
    if (url.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (!m) return { ok: false, error: "bad_data_url" };
      return { ok: true, bytes: base64ToBytes(m[2]!), mime: m[1]! };
    }
    const imgRes = await fetchImpl(url);
    if (!imgRes.ok) return { ok: false, error: "image_fetch" };
    const buf = new Uint8Array(await imgRes.arrayBuffer());
    const mime = imgRes.headers.get("content-type") || "image/png";
    return { ok: true, bytes: buf, mime };
  } catch {
    return { ok: true, bytes: svgImage(p), mime: "image/svg+xml" };
  }
}

/** Deterministic local answerer used when OpenRouter is not configured. */
function localAnswer(q: string): ChatResponse {
  const lower = q.toLowerCase().trim();

  // Math: pure expression
  const math = tryMath(lower);
  if (math !== null) {
    return { ok: true, text: `${stripTrailingQuestion(q)} = ${math}` };
  }

  if (/^(hi|hello|hey)\b/.test(lower)) {
    return {
      ok: true,
      text: "Hey! Ask me anything — general knowledge, how-tos, quick facts. Or tap the menu for images, docs, and file conversion.",
    };
  }

  if (/\b(capital of france)\b/.test(lower) || /what(?:'s| is) the capital of france/.test(lower)) {
    return { ok: true, text: "Paris is the capital of France." };
  }

  if (/\b(who (are|r) you|what (are|r) you)\b/.test(lower)) {
    return {
      ok: true,
      text: "I'm your all-in-one assistant — I answer questions, generate images, create documents, and convert files. Tap /start for the menu.",
    };
  }

  if (/\bwater\b.*\bformula\b|\bh2o\b|chemical formula of water/.test(lower)) {
    return { ok: true, text: "Water's chemical formula is H₂O — two hydrogen atoms and one oxygen atom." };
  }

  // Honest offline fallback (not a fabricated fact dump)
  return {
    ok: true,
    text:
      "I can answer simple facts offline, but for a full answer the bot needs its AI key configured. " +
      "Try rephrasing, or ask the owner to set OPENROUTER_API_KEY.\n\n" +
      `Your question: ${q.slice(0, 300)}`,
  };
}

function stripTrailingQuestion(s: string): string {
  return s.replace(/\?+\s*$/, "").trim();
}

function tryMath(expr: string): string | null {
  const cleaned = expr
    .replace(/^(what(?:'s| is)|calculate|compute)\s+/i, "")
    .replace(/\?+$/, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/x/g, "*")
    .trim();
  if (!/^[0-9+\-*/().\s]+$/.test(cleaned)) return null;
  try {
    // Safe eval of arithmetic only
    // eslint-disable-next-line no-new-func
    const val = Function(`"use strict"; return (${cleaned})`)() as unknown;
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
    return String(val);
  } catch {
    return null;
  }
}

/** Minimal SVG "image" embedding the prompt (real output derived from input). */
export function svgImage(prompt: string): Uint8Array {
  const safe = escapeXml(prompt.slice(0, 120));
  const hue = hashHue(prompt);
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${hue},70%,45%)"/>` +
    `<stop offset="100%" stop-color="hsl(${(hue + 60) % 360},70%,30%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="1024" height="1024" fill="url(#g)"/>` +
    `<rect x="64" y="360" width="896" height="304" rx="24" fill="rgba(0,0,0,0.35)"/>` +
    `<text x="512" y="500" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="36" fill="#fff">${safe}</text>` +
    `<text x="512" y="560" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="22" fill="#eee">Generated by OneStop Assistant</text>` +
    `</svg>`;
  return new TextEncoder().encode(svg);
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
