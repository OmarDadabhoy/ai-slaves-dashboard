// Storage layer for the Vercel deployment. Local mode uses ./data/*.json
// directly in server.js; this file is only loaded by api/ serverless functions.
//
// Backend: Vercel Blob (https://vercel.com/docs/storage/vercel-blob).
//
// Storage shape: ONE BLOB PER ROW. Each collection lives under
// `ai-slaves/<collection>/<id>.json`. Listing a collection scans the prefix
// and fetches every row in parallel.
//
// Why per-row? The previous shape (one blob per collection) means every
// mutation is a read-modify-write of the entire array. Two concurrent
// writers each read the same snapshot, modify their own copy, then race
// to write the blob; the loser's change is silently lost. We hit this in
// production: concurrent POST + PATCH against /api/tasks dropped writes
// (the visible "tickets flicker between states / newly-added tickets
// disappear" symptom). PRs #2/#3/#5 papered over the read side; the
// underlying write collision still landed.
//
// Per-row writes never collide on distinct IDs. Writes against the same
// ID still last-write-wins, but that case is rare (one user, one tab) and
// acceptable. New-row creation (POST) is the hot race path, and the new
// model makes that atomic via @vercel/blob put() with allowOverwrite=false:
// it's a server-side create-or-fail, so two concurrent POSTs that compute
// the same candidate ID can't both win.
//
// Token: BLOB_READ_WRITE_TOKEN is provisioned automatically by Vercel when a
// Blob store is linked to the project.

import { put, list, del } from "@vercel/blob";

const BLOB_PREFIX = process.env.BLOB_PREFIX || "ai-slaves/";
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const COLLECTIONS = [
  "tasks",
  "suggested_changes",
  "followups",
  "done_log",
  "agents",
  "pending_drains",
  "scheduled",
];

const ID_PREFIXES = {
  tasks: "t",
  suggested_changes: "sc",
  followups: "fu",
  done_log: "dl",
  agents: "ag",
  pending_drains: "pd",
  scheduled: "sched",
};

// Max attempts when a generated ID collides with an existing row. With the
// list-then-+1 strategy this is essentially the count of concurrent POSTs
// to the same collection. 30 covers far more contention than we'd ever see
// in this single-user dashboard.
const ID_RETRY_LIMIT = 30;

function rowPath(name, id) {
  return `${BLOB_PREFIX}${name}/${id}.json`;
}

function collectionPrefix(name) {
  return `${BLOB_PREFIX}${name}/`;
}

// In-process cache to dedupe reads inside a single function invocation
// (different routes may hit the same row multiple times per request).
// Keyed per-row so different rows never share cache entries. Cleared at
// the start of every request by the catch-all handler so warm-invocation
// state from a previous request can't leak in.
const requestCache = new Map();

function rowCacheKey(name, id) {
  return `r:${name}:${id}`;
}

function listCacheKey(name) {
  return `L:${name}`;
}

export function clearRequestCache() {
  requestCache.clear();
}

// ============================================================
// Per-row read/write/delete
// ============================================================

async function fetchRowByUrl(url) {
  // Append a unique ts to bypass CDN edge cache, same trick as the old
  // per-collection reader used. Even with cacheControlMaxAge:0 on the
  // write, edge nodes occasionally serve stale bytes for a brief window.
  const fetchUrl = url + (url.includes("?") ? "&" : "?") + `ts=${Date.now()}`;
  const r = await fetch(fetchUrl, { cache: "no-store" });
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`fetch ${url} returned ${r.status}`);
  }
  const raw = await r.text();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] parse failed for ${url}: ${err.message}`);
    return null;
  }
}

async function listAllBlobsForCollection(name) {
  // Vercel Blob list() returns up to `limit` (default 1000) entries with a
  // cursor for the next page. Paginate until we run out. 50-page ceiling is
  // a sanity stop; we'd need 50k rows to hit it.
  const prefix = collectionPrefix(name);
  const all = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await list({ prefix, limit: 1000, cursor, token: TOKEN });
    if (r.blobs && r.blobs.length) all.push(...r.blobs);
    if (!r.cursor || !r.hasMore) break;
    cursor = r.cursor;
  }
  return all;
}

// Returns the array of all rows for a collection. Used by GET /api/<name>
// and by ID generation (to find max numeric suffix).
export async function listRows(name) {
  if (!COLLECTIONS.includes(name)) return [];
  const ck = listCacheKey(name);
  if (requestCache.has(ck)) return requestCache.get(ck);
  const blobs = await listAllBlobsForCollection(name);
  if (blobs.length === 0) {
    requestCache.set(ck, []);
    return [];
  }
  // Fetch every row in parallel. Each row blob is small (one item), so this
  // is cheap even for collections with hundreds of items.
  const rows = await Promise.all(blobs.map((b) => fetchRowByUrl(b.url).catch((err) => {
    console.error(`[store] failed fetching ${b.pathname}: ${err.message}`);
    return null;
  })));
  const items = rows.filter((r) => r != null);
  // Sort newest first (descending). Matches the existing UI expectation:
  // the legacy code unshifted new items onto the array, so consumers
  // assume reverse-chronological order.
  items.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (tb !== ta) return tb - ta;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
  // Per-row cache too: future readRow() for the same row this request
  // hits the local map instead of going back to the network.
  for (const item of items) {
    if (item?.id) requestCache.set(rowCacheKey(name, item.id), item);
  }
  requestCache.set(ck, items);
  return items;
}

export async function readRow(name, id) {
  if (!COLLECTIONS.includes(name)) return null;
  const ck = rowCacheKey(name, id);
  if (requestCache.has(ck)) return requestCache.get(ck);
  // We don't know the public URL without listing, so we look it up via
  // a prefix list scoped to this exact row.
  const prefix = rowPath(name, id);
  const r = await list({ prefix, limit: 1, token: TOKEN });
  if (!r.blobs || r.blobs.length === 0) {
    requestCache.set(ck, null);
    return null;
  }
  const value = await fetchRowByUrl(r.blobs[0].url);
  requestCache.set(ck, value);
  return value;
}

async function putRow(name, id, value, { allowOverwrite }) {
  const key = rowPath(name, id);
  const body = JSON.stringify(value, null, 2) + "\n";
  await put(key, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite,
    token: TOKEN,
    cacheControlMaxAge: 0,
  });
  requestCache.set(rowCacheKey(name, id), value);
  // Invalidate the list cache so the next listRows() call this request
  // returns fresh state including this write.
  requestCache.delete(listCacheKey(name));
}

// Overwrite an existing row, or create a new one if missing. Idempotent
// for PATCH/PUT semantics where the caller already knows the ID.
export async function writeRow(name, id, value) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection ${name}`);
  await putRow(name, id, value, { allowOverwrite: true });
}

export async function deleteRow(name, id) {
  if (!COLLECTIONS.includes(name)) return;
  const pathname = rowPath(name, id);
  try {
    // del() takes either a URL or a pathname; pathname is what we have.
    await del(pathname, { token: TOKEN });
  } catch (err) {
    // If the row already doesn't exist, that's a no-op success. Other
    // errors propagate.
    if (err?.status === 404 || /not found/i.test(err?.message || "")) return;
    throw err;
  }
  requestCache.delete(rowCacheKey(name, id));
  requestCache.delete(listCacheKey(name));
}

// In-place mutation of a single row. Read it, run the mutator, write it
// back to the SAME row. This is the new model's equivalent of the legacy
// mutateCollection but scoped to one row, so concurrent mutators against
// different rows never collide.
//
// Mutator contract: takes the current row (or null if missing) and returns
//   { value, result }                       -> writes value and returns result
//   { skipWrite: true, result }             -> skips write, returns result
export async function mutateRow(name, id, mutator) {
  const current = await readRow(name, id);
  const mutation = await mutator(current);
  if (mutation.skipWrite) return mutation.result;
  if (mutation.value === undefined) {
    throw new Error(`mutateRow(${name}, ${id}): mutator must return {value} or {skipWrite}`);
  }
  await writeRow(name, id, mutation.value);
  return mutation.result;
}

// ============================================================
// ID generation for new rows (POST handler)
// ============================================================
//
// Algorithm:
//   1. List the collection's row blobs (cheap: returns pathnames; no body
//      fetch needed for ID extraction).
//   2. Parse `<prefix>-<NNN>` out of each pathname, find max.
//   3. Try to PUT the next ID with allowOverwrite=false. If it succeeds we
//      win the race. If it errors with a conflict (the blob already exists,
//      e.g. another concurrent POST grabbed the same ID first), retry with
//      the next ID number. Repeat until success or ID_RETRY_LIMIT.
//
// This is race-safe because @vercel/blob put() with allowOverwrite=false
// is an atomic create-or-fail operation server-side. Two concurrent POSTs
// might both compute the same next ID after listing, but only one of them
// will succeed in putRow(); the loser sees the conflict error, computes
// the next ID, and tries again. Net: N concurrent POSTs produce N distinct
// IDs and N persisted rows.

function paddedId(prefix, n) {
  // 3-digit minimum for stylistic consistency with the legacy IDs (t-001).
  // Wider numbers (t-1000+) pass through without truncation.
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

async function listExistingIdsForCollection(name) {
  const prefix = ID_PREFIXES[name];
  if (!prefix) return [];
  const blobs = await listAllBlobsForCollection(name);
  const re = new RegExp(`/${prefix}-(\\d+)\\.json$`);
  const out = [];
  for (const b of blobs) {
    const m = b.pathname.match(re);
    if (m) out.push(parseInt(m[1], 10));
  }
  return out;
}

function isOverwriteConflictError(err) {
  // @vercel/blob throws when allowOverwrite=false and the blob exists.
  // The error class is BlobAccessError with a specific message, but we
  // also pattern-match defensively in case the SDK shape shifts.
  if (!err) return false;
  if (err.name === "BlobAccessError") return true;
  const msg = String(err.message || "");
  return /already exists|allowOverwrite|overwrite/i.test(msg);
}

// Create a new row with an auto-assigned ID. Returns the saved value
// (including the assigned `id`). Race-safe: if two concurrent calls
// land on the same ID, exactly one wins and the loser retries.
//
// `buildValue(id)` is a callback the caller provides; we hand it
// the assigned ID and it returns the fully-formed row object. The
// callback is invoked again on retry with the next ID.
export async function createRow(name, buildValue) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection ${name}`);
  const prefix = ID_PREFIXES[name];
  if (!prefix) throw new Error(`no id prefix for collection ${name}`);

  // Start with max(existing) + 1. If contention is high we may need to
  // skip a few numbers; that's fine.
  const existingNums = await listExistingIdsForCollection(name);
  let candidate = (existingNums.length ? Math.max(...existingNums) : 0) + 1;

  for (let attempt = 0; attempt < ID_RETRY_LIMIT; attempt++) {
    const id = paddedId(prefix, candidate);
    const value = buildValue(id);
    try {
      await putRow(name, id, value, { allowOverwrite: false });
      return value;
    } catch (err) {
      if (!isOverwriteConflictError(err)) throw err;
      // Conflict: someone else grabbed this ID first. Try the next number.
      // Small jitter so a flock of concurrent writers doesn't lock-step.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      candidate++;
    }
  }
  throw new Error(`createRow(${name}) exceeded ${ID_RETRY_LIMIT} ID retries`);
}

// ============================================================
// Compatibility shims
// ============================================================
//
// A few code paths still want a "read all + return array" shape. listRows()
// above is the canonical replacement; keep readCollection as a thin alias
// so older call sites don't need to change.
export async function readCollection(name) {
  return listRows(name);
}

export function isBlobConfigured() {
  return Boolean(TOKEN);
}
