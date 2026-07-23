/**
 * Durable key-value store for domain data (User, Request, GeneratedAsset,
 * indexes, rate counters, owner settings). Backed by Redis when REDIS_URL is
 * set; otherwise an in-process Map (dev / test harness).
 *
 * IMPORTANT: never enumerate the keyspace. Always read collections through
 * explicit index records (arrays of ids) stored under known keys.
 */

export interface DurableStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryStore implements DurableStore {
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** Minimal Redis surface used by the durable store. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

class RedisStore implements DurableStore {
  constructor(
    private readonly client: RedisLike,
    private readonly prefix = "kv:",
  ) {}

  private k(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.k(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.client.set(this.k(key), JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }
}

let _store: DurableStore | null = null;
let _redisPromise: Promise<DurableStore> | null = null;

function memoryStore(): DurableStore {
  return (_store ??= new MemoryStore());
}

/**
 * Resolve the durable store: Redis when REDIS_URL is set, else memory.
 * Injectable for tests via `setStore`.
 */
export function getStore(): DurableStore {
  if (_store) return _store;
  const url =
    typeof process !== "undefined" ? process.env.REDIS_URL : undefined;
  if (!url) return memoryStore();

  // Lazily wire Redis; until connected, callers get the memory fallback via
  // the sync path only when _store is set. We eagerly create a proxy.
  if (!_redisPromise) {
    _redisPromise = (async () => {
      try {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ioredis: any = require("ioredis");
        const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
        const client = new Redis(url, {
          maxRetriesPerRequest: null,
          lazyConnect: false,
        });
        const redis = new RedisStore(client as RedisLike);
        _store = redis;
        return redis;
      } catch {
        return memoryStore();
      }
    })();
  }
  // Sync callers before Redis is ready use memory; after connect, _store flips.
  return memoryStore();
}

/** Test hook — swap the store (e.g. a fresh MemoryStore per suite). */
export function setStore(store: DurableStore | null): void {
  _store = store;
  _redisPromise = null;
}

/** Test helper — brand-new empty memory store. */
export function freshMemoryStore(): DurableStore {
  const s = new MemoryStore();
  _store = s;
  _redisPromise = null;
  return s;
}

/** Append `id` to an index list stored at `indexKey` (deduped, newest last). */
export async function indexPush(
  store: DurableStore,
  indexKey: string,
  id: string,
  maxLen = 500,
): Promise<void> {
  const list = (await store.get<string[]>(indexKey)) ?? [];
  const next = list.filter((x) => x !== id);
  next.push(id);
  while (next.length > maxLen) next.shift();
  await store.set(indexKey, next);
}

/** Read an index list (never scans the keyspace). */
export async function indexList(
  store: DurableStore,
  indexKey: string,
): Promise<string[]> {
  return (await store.get<string[]>(indexKey)) ?? [];
}
