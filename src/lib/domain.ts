/**
 * Durable domain entities + helpers (User, Request, GeneratedAsset).
 * Retention: requests 90 days, assets 7 days.
 */

import { dayKey, now } from "./clock.js";
import { getStore, indexList, indexPush } from "./store.js";

const REQUEST_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ASSET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RequestType = "ask" | "image" | "create_doc" | "convert";
export type UserTier = "free" | "paid";

export interface UserRecord {
  telegram_id: number;
  language_preference: string;
  tier: UserTier;
  created_at: number;
  last_active: number;
  blocked?: boolean;
}

export interface RequestRecord {
  id: string;
  telegram_id: number;
  type: RequestType;
  format?: string;
  timestamp: number;
  summary?: string;
}

export interface GeneratedAsset {
  id: string;
  telegram_id: number;
  file_type: string;
  /** Base64 payload kept for redownload within retention window. */
  storage_path: string;
  file_name: string;
  mime_type: string;
  expiration: number;
  created_at: number;
  prompt?: string;
}

function userKey(id: number): string {
  return `user:${id}`;
}
function requestKey(id: string): string {
  return `request:${id}`;
}
function assetKey(id: string): string {
  return `asset:${id}`;
}
function userRequestsKey(id: number): string {
  return `user:${id}:requests`;
}
function userAssetsKey(id: number): string {
  return `user:${id}:assets`;
}
function rateKey(id: number, day: string): string {
  return `rate:${id}:${day}`;
}
function usageKey(day: string): string {
  return `usage:${day}`;
}

let _seq = 0;
function newId(prefix: string): string {
  _seq = (_seq + 1) % 1e9;
  return `${prefix}_${now().toString(36)}_${_seq.toString(36)}`;
}

export async function upsertUser(
  telegramId: number,
  language = "en",
): Promise<UserRecord> {
  const store = getStore();
  const existing = await store.get<UserRecord>(userKey(telegramId));
  const t = now();
  if (existing) {
    const next = { ...existing, last_active: t, language_preference: language || existing.language_preference };
    await store.set(userKey(telegramId), next);
    return next;
  }
  const created: UserRecord = {
    telegram_id: telegramId,
    language_preference: language || "en",
    tier: "free",
    created_at: t,
    last_active: t,
  };
  await store.set(userKey(telegramId), created);
  return created;
}

export async function getUser(telegramId: number): Promise<UserRecord | undefined> {
  return getStore().get<UserRecord>(userKey(telegramId));
}

export async function setUserTier(telegramId: number, tier: UserTier): Promise<void> {
  const u = await upsertUser(telegramId);
  await getStore().set(userKey(telegramId), { ...u, tier });
}

export async function markUserBlocked(telegramId: number): Promise<void> {
  const u = await getUser(telegramId);
  if (!u) return;
  await getStore().set(userKey(telegramId), { ...u, blocked: true });
}

export async function recordRequest(
  telegramId: number,
  type: RequestType,
  opts?: { format?: string; summary?: string },
): Promise<RequestRecord> {
  const store = getStore();
  const rec: RequestRecord = {
    id: newId("req"),
    telegram_id: telegramId,
    type,
    format: opts?.format,
    timestamp: now(),
    summary: opts?.summary?.slice(0, 200),
  };
  await store.set(requestKey(rec.id), rec);
  await indexPush(store, userRequestsKey(telegramId), rec.id, 200);

  // Daily usage counter (for owner summary)
  const day = dayKey();
  const usage = (await store.get<Record<string, number>>(usageKey(day))) ?? {};
  usage[type] = (usage[type] ?? 0) + 1;
  usage.total = (usage.total ?? 0) + 1;
  await store.set(usageKey(day), usage);

  // Best-effort prune of expired requests for this user (via index, not SCAN)
  await pruneUserRequests(telegramId);
  return rec;
}

async function pruneUserRequests(telegramId: number): Promise<void> {
  const store = getStore();
  const ids = await indexList(store, userRequestsKey(telegramId));
  const cutoff = now() - REQUEST_TTL_MS;
  const keep: string[] = [];
  for (const id of ids) {
    const r = await store.get<RequestRecord>(requestKey(id));
    if (!r || r.timestamp < cutoff) {
      await store.del(requestKey(id));
    } else {
      keep.push(id);
    }
  }
  if (keep.length !== ids.length) await store.set(userRequestsKey(telegramId), keep);
}

export async function saveAsset(
  telegramId: number,
  opts: {
    file_type: string;
    file_name: string;
    mime_type: string;
    bytes: Uint8Array;
    prompt?: string;
  },
): Promise<GeneratedAsset> {
  const store = getStore();
  const t = now();
  const asset: GeneratedAsset = {
    id: newId("asset"),
    telegram_id: telegramId,
    file_type: opts.file_type,
    storage_path: bytesToBase64(opts.bytes),
    file_name: opts.file_name,
    mime_type: opts.mime_type,
    expiration: t + ASSET_TTL_MS,
    created_at: t,
    prompt: opts.prompt,
  };
  await store.set(assetKey(asset.id), asset);
  await indexPush(store, userAssetsKey(telegramId), asset.id, 50);
  await pruneUserAssets(telegramId);
  return asset;
}

export async function getAsset(id: string): Promise<GeneratedAsset | undefined> {
  const asset = await getStore().get<GeneratedAsset>(assetKey(id));
  if (!asset) return undefined;
  if (asset.expiration < now()) {
    await getStore().del(assetKey(id));
    return undefined;
  }
  return asset;
}

async function pruneUserAssets(telegramId: number): Promise<void> {
  const store = getStore();
  const ids = await indexList(store, userAssetsKey(telegramId));
  const t = now();
  const keep: string[] = [];
  for (const id of ids) {
    const a = await store.get<GeneratedAsset>(assetKey(id));
    if (!a || a.expiration < t) {
      await store.del(assetKey(id));
    } else {
      keep.push(id);
    }
  }
  if (keep.length !== ids.length) await store.set(userAssetsKey(telegramId), keep);
}

export async function getUsage(day: string = dayKey()): Promise<Record<string, number>> {
  return (await getStore().get<Record<string, number>>(usageKey(day))) ?? {};
}

export async function incrementRate(telegramId: number): Promise<number> {
  const store = getStore();
  const key = rateKey(telegramId, dayKey());
  const n = ((await store.get<number>(key)) ?? 0) + 1;
  await store.set(key, n);
  return n;
}

export async function getRateCount(telegramId: number): Promise<number> {
  return (await getStore().get<number>(rateKey(telegramId, dayKey()))) ?? 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export { REQUEST_TTL_MS, ASSET_TTL_MS };
