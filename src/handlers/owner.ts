/**
 * Owner controls: rate limits, file size, admin channel, payments toggle.
 * Reachable only by configured owner ids — not listed on the public main menu
 * as a feature for casual users; owners open it via /owner or the Owner button
 * which only appears when the chat user is an owner (registered dynamically).
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { isOwner, loadSettings, saveSettings } from "../lib/settings.js";
import { getUsage } from "../lib/domain.js";
import { dayKey } from "../lib/clock.js";
import { backMenuKeyboard } from "../lib/guards.js";

// Owner panel is a power-user surface (/owner), not on the public main menu.
// Callback `owner:panel` still works for in-panel refresh; always re-check isOwner.

const composer = new Composer<Ctx>();
function panelText(s: Awaited<ReturnType<typeof loadSettings>>, usage: Record<string, number>): string {
  return (
    "Owner controls\n\n" +
    `Free rate limit: ${s.freeRateLimit}/day\n` +
    `Paid rate limit: ${s.paidRateLimit}/day\n` +
    `Max file size: ${Math.floor(s.maxFileBytes / (1024 * 1024))} MB\n` +
    `Admin channel: ${s.adminChannelId ?? "not set"}\n` +
    `Payments: ${s.paymentsEnabled ? "enabled" : "disabled"}\n\n` +
    `Today's usage: ${usage.total ?? 0} requests ` +
    `(ask ${usage.ask ?? 0}, image ${usage.image ?? 0}, docs ${usage.create_doc ?? 0}, convert ${usage.convert ?? 0})`
  );
}

function panelKeyboard(s: Awaited<ReturnType<typeof loadSettings>>) {
  return inlineKeyboard([
    [
      inlineButton("Free −10", "owner:free:-10"),
      inlineButton("Free +10", "owner:free:+10"),
    ],
    [
      inlineButton("Paid −50", "owner:paid:-50"),
      inlineButton("Paid +50", "owner:paid:+50"),
    ],
    [
      inlineButton("Size −5MB", "owner:size:-5"),
      inlineButton("Size +5MB", "owner:size:+5"),
    ],
    [
      inlineButton(
        s.paymentsEnabled ? "Disable payments" : "Enable payments",
        "owner:payments:toggle",
      ),
    ],
    [inlineButton("Refresh usage", "owner:panel")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

async function requireOwner(ctx: Ctx): Promise<boolean> {
  const settings = await loadSettings();
  if (!isOwner(ctx.from?.id, settings)) {
    await ctx.reply("That's only for the bot owner.", { reply_markup: backMenuKeyboard });
    return false;
  }
  return true;
}

async function showPanel(ctx: Ctx, edit: boolean): Promise<void> {
  if (!(await requireOwner(ctx))) return;
  const s = await loadSettings();
  const usage = await getUsage(dayKey());
  const text = panelText(s, usage);
  const markup = panelKeyboard(s);
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: markup });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { reply_markup: markup });
}

composer.command("owner", async (ctx) => {
  await showPanel(ctx, false);
});

composer.callbackQuery("owner:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPanel(ctx, true);
});

composer.callbackQuery(/^owner:free:([+-]\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const delta = Number(ctx.match![1]);
  const s = await loadSettings();
  const next = Math.max(5, s.freeRateLimit + delta);
  await saveSettings({ freeRateLimit: next });
  await showPanel(ctx, true);
});

composer.callbackQuery(/^owner:paid:([+-]\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const delta = Number(ctx.match![1]);
  const s = await loadSettings();
  const next = Math.max(10, s.paidRateLimit + delta);
  await saveSettings({ paidRateLimit: next });
  await showPanel(ctx, true);
});

composer.callbackQuery(/^owner:size:([+-]\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const deltaMb = Number(ctx.match![1]);
  const s = await loadSettings();
  const nextMb = Math.min(50, Math.max(1, Math.floor(s.maxFileBytes / (1024 * 1024)) + deltaMb));
  await saveSettings({ maxFileBytes: nextMb * 1024 * 1024 });
  await showPanel(ctx, true);
});

composer.callbackQuery("owner:payments:toggle", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx))) return;
  const s = await loadSettings();
  await saveSettings({ paymentsEnabled: !s.paymentsEnabled });
  await showPanel(ctx, true);
});

export default composer;
