import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import { clearFlow, touchUser } from "../lib/guards.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. Features register their own buttons via registerMainMenuItem.
const composer = new Composer<Ctx>();

export const WELCOME =
  "👋 Hi! I'm your all-in-one assistant.\n\n" +
  "Ask questions, generate images, create documents, or convert files — just tap a button below.";

composer.command("start", async (ctx) => {
  clearFlow(ctx.session);
  await touchUser(ctx);
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  try {
    await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
  } catch {
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
  }
});

// Global cancel for any multi-step flow
composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx.session);
  try {
    await ctx.editMessageText("Cancelled. Tap a button whenever you're ready.", {
      reply_markup: mainMenuKeyboard(),
    });
  } catch {
    await ctx.reply("Cancelled. Tap a button whenever you're ready.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
});

export default composer;
