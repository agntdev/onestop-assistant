/**
 * Shared flow helpers: cancel, rate-limit gate, user touch, loading.
 */

import type { Context } from "grammy";
import type { Session } from "../bot.js";
import { now } from "./clock.js";
import { upsertUser, type UserRecord } from "./domain.js";
import { checkRate, RATE_LIMIT_MSG, RATE_WARN_MSG } from "./rate-limit.js";
import { maybeSendDailySummary, warnRateLimit } from "./notify.js";
import { loadSettings } from "./settings.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

export const FLOW_TTL_MS = 10 * 60 * 1000;

export function clearFlow(session: Session): void {
  session.step = "idle";
  session.docFormat = undefined;
  session.convertSource = undefined;
  session.flowExpiresAt = undefined;
  session.pendingQuestion = undefined;
  session.pendingPrompt = undefined;
}

export function enterStep(session: Session, step: Session["step"]): void {
  session.step = step;
  session.flowExpiresAt = now() + FLOW_TTL_MS;
}

export function flowExpired(session: Session): boolean {
  return !!session.flowExpiresAt && now() > session.flowExpiresAt;
}

export const cancelKeyboard = inlineKeyboard([
  [inlineButton("Cancel", "flow:cancel")],
]);

export const backMenuKeyboard = inlineKeyboard([
  [inlineButton("⬅️ Back to menu", "menu:main")],
]);

export async function touchUser(ctx: Context): Promise<UserRecord | undefined> {
  const id = ctx.from?.id;
  if (!id) return undefined;
  const lang = ctx.from?.language_code ?? "en";
  return upsertUser(id, lang);
}

/**
 * Gate a billable action. Returns null if allowed (and consumed), or a message
 * already sent to the user when blocked.
 */
export async function gateRequest(
  ctx: Context & { session: Session },
  user: UserRecord | undefined,
): Promise<"ok" | "blocked"> {
  const id = ctx.from?.id;
  if (!id) {
    await ctx.reply("I need to know who you are — open a private chat and try again.");
    return "blocked";
  }
  // Fire-and-forget daily summary check
  void maybeSendDailySummary(ctx.api);

  const settings = await loadSettings();
  const check = await checkRate(id, user, { settings });
  if (!check.allowed) {
    await ctx.reply(RATE_LIMIT_MSG, { reply_markup: backMenuKeyboard });
    void warnRateLimit(ctx.api, id, check.used, check.limit);
    return "blocked";
  }
  if (check.remaining <= 3 && check.remaining >= 0) {
    // Soft warning to the user once they're nearly out
    if (check.remaining === 3) {
      await ctx.reply(RATE_WARN_MSG);
    }
    void warnRateLimit(ctx.api, id, check.used, check.limit);
  }
  return "ok";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
