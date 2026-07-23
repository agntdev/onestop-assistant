import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "Here's what I can do — tap /start to open the menu:\n\n" +
  "• Ask — general knowledge questions\n" +
  "• Image — generate a picture from a prompt\n" +
  "• Create doc — build a PDF, DOCX, or TXT file\n" +
  "• Convert — turn files between common formats\n\n" +
  "Everything is reachable by tapping. You can also type /ask, /image, /create_doc, or /convert with your text right after the command.\n\n" +
  "Files stay available for redownload for 7 days. Requests are kept for analytics for 90 days.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP, { reply_markup: backToMenu });
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(HELP, { reply_markup: backToMenu });
  } catch {
    await ctx.reply(HELP, { reply_markup: backToMenu });
  }
});

export default composer;
