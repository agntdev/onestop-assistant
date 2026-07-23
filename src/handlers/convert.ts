import { Composer, InputFile } from "grammy";
import type { Ctx } from "../bot.js";
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
  formatBytes,
  gateRequest,
  touchUser,
} from "../lib/guards.js";
import { recordRequest, saveAsset } from "../lib/domain.js";
import {
  convertFile,
  detectFormat,
  FORMAT_LABELS,
  isDangerousFile,
  targetsFor,
  type ConvertFormat,
} from "../lib/convert.js";
import { loadSettings } from "../lib/settings.js";
import { alertError } from "../lib/notify.js";

registerMainMenuItem({ label: "🔄 Convert", data: "convert:start", order: 40 });

const composer = new Composer<Ctx>();

const UPLOAD_PROMPT =
  "Send the file you want to convert.\n\n" +
  "I handle TXT, PDF, DOCX, PNG, JPG, and SVG — up to 25 MB.";

function targetKeyboard(source: ConvertFormat | null) {
  const targets = targetsFor(source);
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < targets.length; i += 3) {
    rows.push(
      targets.slice(i, i + 3).map((t) => inlineButton(FORMAT_LABELS[t], `convert:to:${t}`)),
    );
  }
  rows.push([inlineButton("Cancel", "flow:cancel")]);
  return inlineKeyboard(rows);
}

async function promptUpload(ctx: Ctx, edit: boolean): Promise<void> {
  clearFlow(ctx.session);
  enterStep(ctx.session, "convert:awaiting_file");
  if (edit) {
    try {
      await ctx.editMessageText(UPLOAD_PROMPT, { reply_markup: cancelKeyboard });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(UPLOAD_PROMPT, { reply_markup: cancelKeyboard });
}

composer.command("convert", async (ctx) => {
  await promptUpload(ctx, false);
});

composer.callbackQuery("convert:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptUpload(ctx, true);
});

async function acceptFile(
  ctx: Ctx,
  meta: { fileId: string; fileName: string; mimeType?: string; fileSize?: number },
): Promise<void> {
  if (ctx.session.step !== "convert:awaiting_file" && ctx.session.step !== "idle") {
    // Allow starting convert by just dropping a file when idle? Spec says upload then format.
    // Only accept when awaiting.
  }
  if (ctx.session.step !== "convert:awaiting_file") {
    // If user dropped a file without starting convert, nudge them
    if (!ctx.session.step || ctx.session.step === "idle") {
      enterStep(ctx.session, "convert:awaiting_file");
    } else {
      return;
    }
  }

  if (flowExpired(ctx.session)) {
    clearFlow(ctx.session);
    await ctx.reply("That timed out — tap 🔄 Convert when you're ready.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }

  const settings = await loadSettings();
  const size = meta.fileSize ?? 0;
  if (size > settings.maxFileBytes) {
    await ctx.reply(
      `That file is over the ${Math.floor(settings.maxFileBytes / (1024 * 1024))} MB limit (${formatBytes(size)}). Try a smaller one.`,
      { reply_markup: cancelKeyboard },
    );
    return;
  }
  if (isDangerousFile(meta.fileName, meta.mimeType)) {
    await ctx.reply("That file type isn't allowed — I only convert documents and images.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }

  const source = detectFormat(meta.fileName, meta.mimeType);
  ctx.session.convertSource = {
    fileId: meta.fileId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    fileSize: meta.fileSize,
  };
  enterStep(ctx.session, "convert:awaiting_format");

  const label = source ? FORMAT_LABELS[source] : "unknown";
  await ctx.reply(
    `Got it: ${meta.fileName} (${label}${size ? `, ${formatBytes(size)}` : ""}).\n\nConvert it to:`,
    { reply_markup: targetKeyboard(source) },
  );
}

composer.on("message:document", async (ctx, next) => {
  const step = ctx.session.step;
  // create-doc owns document uploads while awaiting content
  if (step === "doc:awaiting_content") return next();
  // Accept while converting, or treat a cold document drop as convert start
  if (
    step &&
    step !== "idle" &&
    step !== "convert:awaiting_file" &&
    step !== "convert:awaiting_format"
  ) {
    return next();
  }

  const doc = ctx.message.document;
  if (!doc) return next();

  if (step !== "convert:awaiting_file") {
    enterStep(ctx.session, "convert:awaiting_file");
  }

  await acceptFile(ctx, {
    fileId: doc.file_id,
    fileName: doc.file_name || "file",
    mimeType: doc.mime_type,
    fileSize: doc.file_size,
  });
});

composer.on("message:photo", async (ctx, next) => {
  // Only accept photos when the user started convert
  if (ctx.session.step !== "convert:awaiting_file") return next();
  const photos = ctx.message.photo;
  if (!photos?.length) return next();
  const best = photos[photos.length - 1]!;
  await acceptFile(ctx, {
    fileId: best.file_id,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    fileSize: best.file_size,
  });
});

composer.callbackQuery(/^convert:to:(txt|pdf|docx|png|jpg|svg)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const target = ctx.match![1]! as ConvertFormat;
  const src = ctx.session.convertSource;
  if (!src) {
    await promptUpload(ctx, true);
    return;
  }

  const user = await touchUser(ctx);
  if ((await gateRequest(ctx, user)) === "blocked") {
    clearFlow(ctx.session);
    return;
  }

  await ctx.replyWithChatAction("upload_document");
  try {
    await ctx.editMessageText(`Converting to ${FORMAT_LABELS[target]}…`);
  } catch {
    await ctx.reply(`Converting to ${FORMAT_LABELS[target]}…`);
  }

  try {
    const file = await ctx.api.getFile(src.fileId);
    const path = file.file_path;
    if (!path) {
      clearFlow(ctx.session);
      await ctx.reply("Couldn't download that file from Telegram. Send it again?", {
        reply_markup: backMenuKeyboard,
      });
      return;
    }
    const token = ctx.api.token;
    const url = `https://api.telegram.org/file/bot${token}/${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      clearFlow(ctx.session);
      await ctx.reply("Couldn't download that file. Send it again?", {
        reply_markup: backMenuKeyboard,
      });
      return;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const settings = await loadSettings();
    const result = convertFile({
      bytes,
      fileName: src.fileName,
      mime: src.mimeType,
      target,
      maxBytes: settings.maxFileBytes,
    });

    if (!result.ok) {
      clearFlow(ctx.session);
      await ctx.reply(result.message, {
        reply_markup: inlineKeyboard([
          [inlineButton("Try another file", "convert:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      });
      return;
    }

    const asset = await saveAsset(ctx.from!.id, {
      file_type: result.format,
      file_name: result.fileName,
      mime_type: result.mime,
      bytes: result.bytes,
    });
    await recordRequest(ctx.from!.id, "convert", {
      format: `${src.fileName}->${result.format}`,
      summary: src.fileName,
    });
    ctx.session.lastAssetId = asset.id;
    clearFlow(ctx.session);

    await ctx.replyWithDocument(new InputFile(result.bytes, result.fileName), {
      caption: `Done — converted to ${FORMAT_LABELS[result.format]}. Kept for 7 days.`,
      reply_markup: inlineKeyboard([
        [inlineButton("Convert another", "convert:start")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
  } catch (err) {
    clearFlow(ctx.session);
    await ctx.reply("Conversion failed. Try another file or format.", {
      reply_markup: backMenuKeyboard,
    });
    void alertError(
      ctx.api,
      "convert failed",
      err instanceof Error ? err.message : String(err),
    );
  }
});

// Timeout messaging when user types while awaiting file
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "convert:awaiting_file") return next();
  if (ctx.message.text.startsWith("/")) return next();
  if (flowExpired(ctx.session)) {
    clearFlow(ctx.session);
    await ctx.reply("That timed out — tap 🔄 Convert when you're ready.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }
  await ctx.reply("Send a file (document or photo) to convert, or tap Cancel.", {
    reply_markup: cancelKeyboard,
  });
});

export default composer;
