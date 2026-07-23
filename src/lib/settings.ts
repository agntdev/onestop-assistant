/**
 * Owner-configurable runtime settings + env defaults.
 * Durable copy lives under a single known key (no keyspace scans).
 */

import { getStore } from "./store.js";

export interface OwnerSettings {
  /** Free-tier requests per user per UTC day. */
  freeRateLimit: number;
  /** Paid-tier requests per user per UTC day. */
  paidRateLimit: number;
  /** Max upload size in bytes (default 25 MB). */
  maxFileBytes: number;
  /** Telegram chat id for admin alerts (channel or private). */
  adminChannelId?: number;
  /** Whether Telegram Payments integration is enabled. */
  paymentsEnabled: boolean;
  /** Owner telegram user ids (numeric). */
  ownerIds: number[];
}

const SETTINGS_KEY = "settings:owner";

const DEFAULT_MAX_FILE = 25 * 1024 * 1024;

function parseOwnerIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function envDefaults(): OwnerSettings {
  const env = typeof process !== "undefined" ? process.env : {};
  const free = Number(env.RATE_LIMIT_FREE ?? "40");
  const paid = Number(env.RATE_LIMIT_PAID ?? "400");
  const maxMb = Number(env.MAX_FILE_SIZE_MB ?? "25");
  const admin = env.ADMIN_CHANNEL_ID ? Number(env.ADMIN_CHANNEL_ID) : undefined;
  return {
    freeRateLimit: Number.isFinite(free) && free > 0 ? free : 40,
    paidRateLimit: Number.isFinite(paid) && paid > 0 ? paid : 400,
    maxFileBytes:
      Number.isFinite(maxMb) && maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : DEFAULT_MAX_FILE,
    adminChannelId: Number.isFinite(admin as number) ? (admin as number) : undefined,
    paymentsEnabled: (env.PAYMENTS_ENABLED ?? "false").toLowerCase() === "true",
    ownerIds: parseOwnerIds(env.OWNER_TELEGRAM_IDS ?? env.OWNER_TELEGRAM_ID),
  };
}

/** Load owner settings (stored overrides layered on env defaults). */
export async function loadSettings(): Promise<OwnerSettings> {
  const base = envDefaults();
  const stored = await getStore().get<Partial<OwnerSettings>>(SETTINGS_KEY);
  if (!stored) return base;
  return {
    freeRateLimit: stored.freeRateLimit ?? base.freeRateLimit,
    paidRateLimit: stored.paidRateLimit ?? base.paidRateLimit,
    maxFileBytes: stored.maxFileBytes ?? base.maxFileBytes,
    adminChannelId: stored.adminChannelId ?? base.adminChannelId,
    paymentsEnabled: stored.paymentsEnabled ?? base.paymentsEnabled,
    ownerIds:
      stored.ownerIds && stored.ownerIds.length > 0 ? stored.ownerIds : base.ownerIds,
  };
}

/** Persist a partial settings update. */
export async function saveSettings(patch: Partial<OwnerSettings>): Promise<OwnerSettings> {
  const current = await loadSettings();
  const next: OwnerSettings = { ...current, ...patch };
  await getStore().set(SETTINGS_KEY, next);
  return next;
}

export function isOwner(userId: number | undefined, settings: OwnerSettings): boolean {
  if (!userId) return false;
  return settings.ownerIds.includes(userId);
}

export { DEFAULT_MAX_FILE };
