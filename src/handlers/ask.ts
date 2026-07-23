import { Composer } from "grammy";
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
import { recordRequest } from "../lib/domain.js";
import { answerQuestion } from "../lib/openrouter.js";
import { alertError } from "../lib/notify.js";

registerMainMenuItem({ label: "💬 Ask", data: "ask:start", order: 10 });

const composer = new Composer<Ctx>();

const PROMPT =
  "What's your question? Type it below — anything from quick facts to how-tos.";

function moreDetailsKeyboard() {
  return inlineKeyboard([
    [inlineButton("More details", "ask:more")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

async function promptForQuestion(ctx: Ctx, edit: boolean): Promise<void> {
  enterStep(ctx.session, "ask:awaiting");
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

async function runAsk(ctx: Ctx, question: string): Promise<void> {
  const user = await touchUser(ctx);
  if ((await gateRequest(ctx, user)) === "blocked") {
    clearFlow(ctx.session);
    return;
  }

  const q = question.trim();
  if (!q) {
    await promptForQuestion(ctx, false);
    return;
  }
  if (q.length > 2000) {
    await ctx.reply("That's a bit long — keep your question under 2000 characters.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }

  clearFlow(ctx.session);
  await ctx.replyWithChatAction("typing");
  const placeholder = await ctx.reply("Thinking…");

  try {
    const result = await answerQuestion(q, {
      language: user?.language_preference ?? ctx.from?.language_code ?? "en",
    });
    await recordRequest(ctx.from!.id, "ask", { summary: q });

    if (!result.ok) {
      const msg =
        result.error === "rate_limit"
          ? "The answer service is busy right now. Try again in a moment."
          : "Couldn't get an answer right now. Try again in a moment.";
      try {
        await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, msg, {
          reply_markup: backMenuKeyboard,
        });
      } catch {
        await ctx.reply(msg, { reply_markup: backMenuKeyboard });
      }
      void alertError(ctx.api, "ask failed", result.error);
      return;
    }

    ctx.session.lastQuestion = q;
    ctx.session.lastAnswer = result.text;
    const text = result.text.slice(0, 3900);
    try {
      await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, text, {
        reply_markup: moreDetailsKeyboard(),
      });
    } catch {
      await ctx.reply(text, { reply_markup: moreDetailsKeyboard() });
    }
  } catch (err) {
    const msg = "Something went wrong answering that. Try again?";
    try {
      await ctx.api.editMessageText(ctx.chat!.id, placeholder.message_id, msg, {
        reply_markup: backMenuKeyboard,
      });
    } catch {
      await ctx.reply(msg, { reply_markup: backMenuKeyboard });
    }
    void alertError(ctx.api, "ask exception", err instanceof Error ? err.message : String(err));
  }
}

composer.command("ask", async (ctx) => {
  const arg = ctx.match?.toString().trim() ?? "";
  if (arg) {
    await runAsk(ctx, arg);
    return;
  }
  await promptForQuestion(ctx, false);
});

composer.callbackQuery("ask:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await promptForQuestion(ctx, true);
});

composer.callbackQuery("ask:more", async (ctx) => {
  await ctx.answerCallbackQuery();
  const prev = ctx.session.lastAnswer;
  const q = ctx.session.lastQuestion;
  if (!prev || !q) {
    await ctx.reply("Nothing to expand yet — ask a question first.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }
  await ctx.replyWithChatAction("typing");
  const follow = await answerQuestion(
    `Expand on your previous answer with more detail and examples.\n\nQuestion: ${q}\n\nPrevious answer:\n${prev}`,
    { language: ctx.from?.language_code ?? "en" },
  );
  if (!follow.ok) {
    await ctx.reply("Couldn't load more details right now. Try again in a moment.", {
      reply_markup: moreDetailsKeyboard(),
    });
    return;
  }
  ctx.session.lastAnswer = follow.text;
  await ctx.reply(follow.text.slice(0, 3900), { reply_markup: moreDetailsKeyboard() });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "ask:awaiting") return next();
  if (flowExpired(ctx.session)) {
    clearFlow(ctx.session);
    await ctx.reply("That timed out — tap 💬 Ask when you're ready.", {
      reply_markup: backMenuKeyboard,
    });
    return;
  }
  // Ignore slash commands while awaiting (let other handlers/commands run)
  if (ctx.message.text.startsWith("/")) return next();
  await runAsk(ctx, ctx.message.text);
});

export default composer;
