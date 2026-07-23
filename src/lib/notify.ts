/**
 * Owner notifications: error alerts, rate-limit warnings, daily usage summary.
 * Every DM/channel post is wrapped to tolerate 403 (blocked / never started).
 */

import type { Api } from "grammy";
import { dayKey, now } from "./clock.js";
import { getUsage, markUserBlocked } from "./domain.js";
import { getStore } from "./store.js";
import { loadSettings } from "./settings.js";

const LAST_SUMMARY_KEY = "notify:last_summary_day";
const RATE_WARN_KEY = (uid: number, day: string) => `notify:ratewarn:${uid}:${day}`;

/** Safe send — never throws into the caller's flow. Returns false on failure. */
export async function safeSend(
  api: Api,
  chatId: number | string,
  text: string,
): Promise<boolean> {
  try {
    await api.sendMessage(chatId, text);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Telegram 403: bot was blocked or user never started the bot
    if (msg.includes("403") || /blocked|forbidden|deactivated/i.test(msg)) {
      const n = typeof chatId === "number" ? chatId : Number(chatId);
      if (Number.isFinite(n)) await markUserBlocked(n).catch(() => {});
    }
    return false;
  }
}

export async function notifyOwner(api: Api, text: string): Promise<void> {
  const settings = await loadSettings();
  const targets = new Set<number>();
  if (settings.adminChannelId) targets.add(settings.adminChannelId);
  for (const id of settings.ownerIds) targets.add(id);
  for (const id of targets) {
    await safeSend(api, id, text);
  }
}

export async function alertError(api: Api, context: string, detail?: string): Promise<void> {
  const body =
    `⚠️ Bot error\n${context}` + (detail ? `\n${detail.slice(0, 400)}` : "");
  await notifyOwner(api, body);
}

export async function warnRateLimit(
  api: Api,
  userId: number,
  used: number,
  limit: number,
): Promise<void> {
  // Once per user per day
  const key = RATE_WARN_KEY(userId, dayKey());
  if (await getStore().get<boolean>(key)) return;
  await getStore().set(key, true);
  await notifyOwner(
    api,
    `🚦 Rate-limit warning\nUser ${userId} used ${used}/${limit} requests today.`,
  );
}

/**
 * On any user action: if we haven't sent today's summary yet and it's past
 * 18:00 UTC (or a new day rolled over), send the previous day's totals.
 */
export async function maybeSendDailySummary(api: Api): Promise<void> {
  const settings = await loadSettings();
  if (!settings.adminChannelId && settings.ownerIds.length === 0) return;

  const today = dayKey();
  const last = await getStore().get<string>(LAST_SUMMARY_KEY);
  if (last === today) return;

  // Send once the UTC hour is >= 18, or if we missed a day entirely.
  const hour = new Date(now()).getUTCHours();
  if (last === undefined && hour < 18) return;

  // Summarize yesterday when rolling over
  const yest = dayKey(now() - 24 * 60 * 60 * 1000);
  const usage = await getUsage(last && last !== today ? last : yest);
  const total = usage.total ?? 0;
  const lines = [
    `📊 Daily usage (${last && last !== today ? last : yest})`,
    `Total requests: ${total}`,
    `Ask: ${usage.ask ?? 0}`,
    `Image: ${usage.image ?? 0}`,
    `Docs: ${usage.create_doc ?? 0}`,
    `Convert: ${usage.convert ?? 0}`,
  ];
  await notifyOwner(api, lines.join("\n"));
  await getStore().set(LAST_SUMMARY_KEY, today);
}
