import { Composer, InputFile } from "grammy";
import type { Ctx, DocFormatChoice } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import {
  backMenuKeyboard,
  cancelKeyboard,
  clearFlow,
  enterStep,
  flowExpired,
  gateRequest,
  touchUser,
} from "../lib/guards.js";
import { recordRequest, saveAsset } from "../lib/domain.js";
import { buildDocument } from "../lib/documents.js";
import { alertError } from "../lib/notify.js";

registerMainMenuItem({ label: "📄 Create doc", data: "doc:start", order: 30 });

const composer = new Composer<Ctx>();

const FORMAT_PROMPT = "Pick a format for your document:";

const formatKeyboard = inlineKeyboard([
  [
    inlineButton("PDF", "doc:fmt:pdf"),
    inlineButton("DOCX", "doc:fmt:docx"),
    inlineButton("TXT", "doc:fmt:txt"),
  ],
  [inlineButton("Cancel", "flow:cancel")],
]);

function contentPrompt(fmt: DocFormatChoice): string {
  return (
    `Send the text for your ${fmt.toUpperCase()} — paste or type it below.\n\n` +
    "Tip: keep it under ~8000 characters for best results."
  );
}

async function showFormatPicker(ctx: Ctx, edit: boolean): Promise<void> {
  clearFlow(ctx.session);
  enterStep(ctx.session, "idle");
  if (edit) {
    try {
      await ctx.editMessageText(FORMAT_PROMPT, { reply_markup: formatKeyboard });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(FORMAT_PROMPT, { reply_markup: formatKeyboard });
}

async function buildAndSend(ctx: Ctx, format: DocFormatChoice, content: string): Promise<void> {
  const user = await touchUser(ctx);
  if ((await gateRequest(ctx, user)) === "blocked") {
    clearFlow(ctx.session);
    return;
  }

  const body = content.trim();
  if (!body) {
    await ctx.reply("I need some text to put in the document. Paste it below.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }
  if (body.length > 20000) {
    await ctx.reply("That's too long for one document — trim it under 20,000 characters.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }

  clearFlow(ctx.session);
  await ctx.replyWithChatAction("upload_document");
  const placeholder = await ctx.reply("Building your document…");

  try {
    const title = body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 40) || "document";
    const doc = buildDocument(body, format, title);
    const asset = await saveAsset(ctx.from!.id, {
      file_type: format,
      file_name: doc.fileName,
      mime_type: doc.mime,
      bytes: doc.bytes,
    });
    await recordRequest(ctx.from!.id, "create_doc", {
      format,
      summary: body.slice(0, 120),
    });
    ctx.session.lastAssetId = asset.id;

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, placeholder.message_id);
    } catch {
      /* ignore */
    }

    await ctx.replyWithDocument(new InputFile(doc.bytes, doc.fileName), {
      caption: `Your ${format.toUpperCase()} is ready. Kept for redownload for 7 days.`,
      reply_markup: inlineKeyboard([
        [inlineButton("Create another", "doc:start")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.message === "empty_content"
        ? "I need some text to put in the document."
        : "Couldn't build that document — the content may be malformed. Try simpler text.";
    try {
      await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, msg, {
        reply_markup: backMenuKeyboard,
      });
    } catch {
      await ctx.reply(msg, { reply_markup: backMenuKeyboard });
    }
    void alertError(ctx.api, "create_doc failed", err instanceof Error ? err.message : String(err));
  }
}

composer.command("create_doc", async (ctx) => {
  // Optional: /create_doc pdf ...rest as content
  const arg = ctx.match?.toString().trim() ?? "";
  if (arg) {
    const m = /^(pdf|docx|txt)\b\s*([\s\S]*)$/i.exec(arg);
    if (m && m[2]?.trim()) {
      await buildAndSend(ctx, m[1]!.toLowerCase() as DocFormatChoice, m[2]!);
      return;
    }
  }
  await showFormatPicker(ctx, false);
});

composer.callbackQuery("doc:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showFormatPicker(ctx, true);
});

composer.callbackQuery(/^doc:fmt:(pdf|docx|txt)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const fmt = ctx.match![1]! as DocFormatChoice;
  ctx.session.docFormat = fmt;
  enterStep(ctx.session, "doc:awaiting_content");
  try {
    await ctx.editMessageText(contentPrompt(fmt), { reply_markup: cancelKeyboard });
  } catch {
    await ctx.reply(contentPrompt(fmt), { reply_markup: cancelKeyboard });
  }
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "doc:awaiting_content") return next();
  if (flowExpired(ctx.session)) {
    clearFlow(ctx.session);
    await ctx.reply("That timed out — tap 📄 Create doc when you're ready.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }
  if (ctx.message.text.startsWith("/")) return next();
  const fmt = ctx.session.docFormat;
  if (!fmt) {
    clearFlow(ctx.session);
    await showFormatPicker(ctx, false);
    return;
  }
  await buildAndSend(ctx, fmt, ctx.message.text);
});

// Also accept a document/caption as content source? Spec says "content text, attachments"
// — accept a .txt document upload while awaiting content.
composer.on("message:document", async (ctx, next) => {
  if (ctx.session.step !== "doc:awaiting_content") return next();
  const fmt = ctx.session.docFormat;
  if (!fmt) return next();

  const doc = ctx.message.document;
  if (!doc) return next();
  if ((doc.file_size ?? 0) > 2 * 1024 * 1024) {
    await ctx.reply("That attachment is too big for content — paste text instead (under 2 MB as a file).", {
      reply_markup: cancelKeyboard,
    });
    return;
  }
  try {
    const file = await ctx.getFile();
    const path = file.file_path;
    if (!path) {
      await ctx.reply("Couldn't download that file. Paste the text instead.", {
        reply_markup: cancelKeyboard,
      });
      return;
    }
    // In the harness, getFile is stubbed — handle gracefully
    const token = ctx.api.token;
    const url = `https://api.telegram.org/file/bot${token}/${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply("Couldn't download that file. Paste the text instead.", {
        reply_markup: cancelKeyboard,
      });
      return;
    }
    const text = await res.text();
    await buildAndSend(ctx, fmt, text);
  } catch {
    await ctx.reply("Couldn't read that attachment. Paste the text instead.", {
      reply_markup: cancelKeyboard,
    });
  }
});

export default composer;
