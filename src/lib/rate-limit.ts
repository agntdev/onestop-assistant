import { getRateCount, incrementRate, type UserRecord } from "./domain.js";
import { loadSettings, type OwnerSettings } from "./settings.js";

export interface RateCheck {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}

export function limitFor(user: UserRecord | undefined, settings: OwnerSettings): number {
  if (user?.tier === "paid") return settings.paidRateLimit;
  return settings.freeRateLimit;
}

/** Check (and optionally consume) one request against the user's daily quota. */
export async function checkRate(
  telegramId: number,
  user: UserRecord | undefined,
  opts?: { consume?: boolean; settings?: OwnerSettings },
): Promise<RateCheck> {
  const settings = opts?.settings ?? (await loadSettings());
  const limit = limitFor(user, settings);
  const usedBefore = await getRateCount(telegramId);
  if (usedBefore >= limit) {
    return { allowed: false, used: usedBefore, limit, remaining: 0 };
  }
  const used = opts?.consume === false ? usedBefore : await incrementRate(telegramId);
  return {
    allowed: true,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

export const RATE_LIMIT_MSG =
  "You've hit today's free limit. Come back tomorrow, or ask the owner about a paid plan.";

export const RATE_WARN_MSG =
  "Heads up — you're close to today's request limit.";
