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
  gateRequest,
  touchUser,
} from "../lib/guards.js";
import { base64ToBytes, getAsset, recordRequest, saveAsset } from "../lib/domain.js";
import { generateImage } from "../lib/openrouter.js";
import { alertError } from "../lib/notify.js";

registerMainMenuItem({ label: "🖼 Image", data: "image:start", order: 20 });

const composer = new Composer<Ctx>();

const PROMPT =
  "Describe the image you want — subject, style, mood. I'll generate it from your prompt.";

function downloadKeyboard(assetId: string) {
  return inlineKeyboard([
    [inlineButton("⬇️ Download", `image:dl:${assetId}`)],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

async function promptForImage(ctx: Ctx, edit: boolean): Promise<void> {
  enterStep(ctx.session, "image:awaiting");
  if (edit) {
    try {
      await ctx.editMessageText(PROMPT, { reply_markup: cancelKeyboard });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(PROMPT, { reply_markup: cancelKeyboard });
}

async function runImage(ctx: Ctx, prompt: string): Promise<void> {
  const user = await touchUser(ctx);
  if ((await gateRequest(ctx, user)) === "blocked") {
    clearFlow(ctx.session);
    return;
  }

  const p = prompt.trim();
  if (!p) {
    await promptForImage(ctx, false);
    return;
  }
  if (p.length > 1500) {
    await ctx.reply("Keep the prompt under 1500 characters so I can work with it.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }

  clearFlow(ctx.session);
  await ctx.replyWithChatAction("upload_photo");
  const placeholder = await ctx.reply("Generating your image…");

  try {
    const result = await generateImage(p);
    await recordRequest(ctx.from!.id, "image", { summary: p });

    if (!result.ok) {
      const msg =
        result.error === "rate_limit"
          ? "Image generation is busy right now. Try again in a minute."
          : "Couldn't generate that image. Try a different prompt.";
      try {
        await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, msg, {
          reply_markup: backMenuKeyboard,
        });
      } catch {
        await ctx.reply(msg, { reply_markup: backMenuKeyboard });
      }
      void alertError(ctx.api, "image failed", result.error);
      return;
    }

    const ext =
      result.mime.includes("svg")
        ? "svg"
        : result.mime.includes("jpeg") || result.mime.includes("jpg")
          ? "jpg"
          : "png";
    const fileName = `image.${ext}`;
    const asset = await saveAsset(ctx.from!.id, {
      file_type: ext,
      file_name: fileName,
      mime_type: result.mime,
      bytes: result.bytes,
      prompt: p,
    });
    ctx.session.lastAssetId = asset.id;

    // Delete placeholder, send media
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, placeholder.message_id);
    } catch {
      /* ignore */
    }

    const file = new InputFile(result.bytes, fileName);
    const caption = `Here's your image for: ${p.slice(0, 200)}`;
    if (ext === "svg") {
      await ctx.replyWithDocument(file, {
        caption,
        reply_markup: downloadKeyboard(asset.id),
      });
    } else {
      try {
        await ctx.replyWithPhoto(file, {
          caption,
          reply_markup: downloadKeyboard(asset.id),
        });
      } catch {
        await ctx.replyWithDocument(file, {
          caption,
          reply_markup: downloadKeyboard(asset.id),
        });
      }
    }
  } catch (err) {
    const msg = "Something went wrong generating that image. Try again?";
    try {
      await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, msg, {
        reply_markup: backMenuKeyboard,
      });
    } catch {
      await ctx.reply(msg, { reply_markup: backMenuKeyboard });
    }
    void alertError(ctx.api, "image exception", err instanceof Error ? err.message : String(err));
  }
}

composer.command("image", async (ctx) => {
  const arg = ctx.match?.toString().trim() ?? "";
  if (arg) {
    await runImage(ctx, arg);
    return;
  }
  await promptForImage(ctx, false);
});

composer.callbackQuery("image:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptForImage(ctx, true);
});

composer.callbackQuery(/^image:dl:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const assetId = ctx.match![1]!;
  const asset = await getAsset(assetId);
  if (!asset || asset.telegram_id !== ctx.from?.id) {
    await ctx.reply(
      "That file expired or isn't available. Generated files are kept for 7 days — make a new one?",
      { reply_markup: backMenuKeyboard },
    );
    return;
  }
  const bytes = base64ToBytes(asset.storage_path);
  await ctx.replyWithDocument(new InputFile(bytes, asset.file_name), {
    caption: "Here's your file again.",
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "image:awaiting") return next();
  if (flowExpired(ctx.session)) {
    clearFlow(ctx.session);
    await ctx.reply("That timed out — tap 🖼 Image when you're ready.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }
  if (ctx.message.text.startsWith("/")) return next();
  await runImage(ctx, ctx.message.text);
});

export default composer;
