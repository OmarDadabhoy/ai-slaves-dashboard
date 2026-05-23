// Storage layer for the Vercel deployment. Local mode uses ./data/*.json
// directly in server.js; this file is only loaded by api/ serverless functions.
//
// Backend: Vercel Blob (https://vercel.com/docs/storage/vercel-blob).
//
// ============================================================
// Storage shape — version 3 (cache-defeating per-row)
// ============================================================
//
// For each row in <collection>, two blob paths exist:
//
//   ai-slaves/<collection>/<id>.lock
//       Tiny marker created on row birth via put({allowOverwrite:false}).
//       This is the atomic ID-uniqueness guarantee: two concurrent POSTs
//       that pick the same candidate ID can't both win the lock PUT.
//
//   ai-slaves/<collection>/<id>-<randomVersion>.json
//       The actual row content. Random-suffixed so EVERY write produces a
//       NEW URL. Vercel Blob's public CDN caches by URL for 60s minimum
//       (the cacheControlMaxAge:0 option is silently clamped to 60s for
//       public stores). A fresh URL means a fresh fetch — no CDN flicker.
//
// Reading a row:
//   list({prefix: "ai-slaves/<collection>/<id>-"}), sort by uploadedAt desc,
//   fetch the freshest URL. (We ignore the lock file when reading.)
//
// Writing a row (PATCH/PUT):
//   put({addRandomSuffix:true, allowOverwrite:true}) to write a NEW URL,
//   then list older versions and delete them. Last-writer-wins on the
//   SAME row is acceptable for this single-user dashboard.
//
// Creating a row (POST):
//   1. List existing rows in the collection, find max numeric suffix.
//   2. Try put({allowOverwrite:false}) on the lock path. On conflict,
//      bump the candidate ID and retry.
//   3. Once lock acquired, put the content with a random suffix.
//
// Deleting a row:
//   Delete the lock and every content blob at the row's prefix.
//
// ============================================================
// Why version 3 and not "just per-row blobs"
// ============================================================
//
// V1 was one blob per collection — concurrent writers raced on the whole
// array and last-writer-wins lost everyone else's changes (PRs #2/#3/#5
// chased this but never killed it).
//
// V2 was one stable-URL blob per row — fixed the collision problem but
// hit a different bug: Vercel Blob's public-blob CDN caches each URL for
// at least 60 seconds. cacheControlMaxAge:0 is silently raised to 60s.
// PUTting the same path twice in <60s would return the cached version to
// any reader for the rest of the cache window. Same flicker, different
// mechanism.
//
// V3 uses a fresh URL per write so the CDN never has stale state — every
// fetch is a brand-new URL with x-vercel-cache: MISS, served straight
// from origin storage.

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

// Max attempts when a generated ID collides with an existing row.
const ID_RETRY_LIMIT = 30;

// Cap on stale content-version blobs we leave behind after a write.
// Each write inserts a new versioned blob; we delete the rest. If a
// deletion fails (network blip), the next write picks up the slack.
const KEEP_OLDEST_VERSIONS = 0; // delete all but the latest

function lockPath(name, id) {
  return `${BLOB_PREFIX}${name}/${id}.lock`;
}

function contentPathPrefix(name, id) {
  // Trailing "-" so list() returns only this row's versions and never
  // matches a sibling row whose id is a prefix (t-696 vs t-696something).
  return `${BLOB_PREFIX}${name}/${id}-`;
}

function contentPathStem(name, id) {
  // Pass to put({addRandomSuffix:true}); the SDK inserts "-<random>"
  // before the `.json` extension. We need to include the extension here
  // so the resulting pathname is `<id>-<random>.json`.
  return `${BLOB_PREFIX}${name}/${id}.json`;
}

function collectionContentPrefix(name) {
  return `${BLOB_PREFIX}${name}/`;
}

// In-process cache to dedupe reads inside a single function invocation.
// Cleared at the start of every request by the catch-all handler.
const requestCache = new Map();
function rowCacheKey(name, id) { return `r:${name}:${id}`; }
function listCacheKey(name) { return `L:${name}`; }

export function clearRequestCache() {
  requestCache.clear();
}

// ============================================================
// Internals
// ============================================================

async function paginatedList(prefix) {
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

async function fetchUrl(url) {
  const r = await fetch(url, { cache: "no-store" });
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

function isContentBlob(pathname) {
  // Content blobs end in `-<random>.json` (new shape) or `<id>.json`
  // (legacy V2 per-row shape, kept readable for the cutover window).
  // Lock files (`<id>.lock`) and the legacy V1 collection blob
  // (`<collection>.json` at the collection root) are filtered elsewhere.
  if (!pathname.endsWith(".json")) return false;
  if (pathname.endsWith(".lock")) return false;
  return true;
}

function pickLatest(blobs) {
  if (!blobs || blobs.length === 0) return null;
  return blobs.slice().sort((a, b) => +b.uploadedAt - +a.uploadedAt)[0];
}

function extractIdFromContentPath(pathname, prefix) {
  // Two recognized shapes:
  //   <BLOB_PREFIX><collection>/<idPrefix>-NNN-<random>.json    (new V3)
  //   <BLOB_PREFIX><collection>/<idPrefix>-NNN.json             (legacy V2)
  // Returns the id (`<idPrefix>-NNN`) or null.
  const escPrefix = BLOB_PREFIX.replace(/\//g, "\\/");
  const v3 = new RegExp(
    `^${escPrefix}[^/]+/(${prefix}-\\d+)-[A-Za-z0-9]+\\.json$`
  );
  let m = pathname.match(v3);
  if (m) return m[1];
  const v2 = new RegExp(
    `^${escPrefix}[^/]+/(${prefix}-\\d+)\\.json$`
  );
  m = pathname.match(v2);
  if (m) return m[1];
  return null;
}

// Group content blobs by row id, returning the latest version per id.
function latestPerId(blobs, idPrefix) {
  const latestById = new Map();
  for (const b of blobs) {
    if (!isContentBlob(b.pathname)) continue;
    const id = extractIdFromContentPath(b.pathname, idPrefix);
    if (!id) continue;
    const prev = latestById.get(id);
    if (!prev || +b.uploadedAt > +prev.uploadedAt) latestById.set(id, b);
  }
  return latestById;
}

// ============================================================
// Public API: read/list
// ============================================================

export async function listRows(name) {
  if (!COLLECTIONS.includes(name)) return [];
  const ck = listCacheKey(name);
  if (requestCache.has(ck)) return requestCache.get(ck);

  const idPrefix = ID_PREFIXES[name];
  const blobs = await paginatedList(collectionContentPrefix(name));
  const latestById = latestPerId(blobs, idPrefix);
  if (latestById.size === 0) {
    requestCache.set(ck, []);
    return [];
  }
  // Fetch latest version of every row in parallel.
  const entries = [...latestById.values()];
  const rows = await Promise.all(entries.map((b) => fetchUrl(b.url).catch((err) => {
    console.error(`[store] failed fetching ${b.pathname}: ${err.message}`);
    return null;
  })));
  const items = rows.filter((r) => r != null);
  // Sort newest first.
  items.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (tb !== ta) return tb - ta;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
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
  // List all content versions for this row, pick the freshest. We use a
  // broad prefix and re-filter via extractIdFromContentPath to handle
  // both V3 (`<id>-<random>.json`) and legacy V2 (`<id>.json`) layouts
  // without accidentally matching a sibling like t-10 when reading t-1.
  const idPrefix = ID_PREFIXES[name];
  const blobs = await paginatedList(`${BLOB_PREFIX}${name}/${id}`);
  const versions = blobs
    .filter((b) => isContentBlob(b.pathname))
    .filter((b) => extractIdFromContentPath(b.pathname, idPrefix) === id);
  const latest = pickLatest(versions);
  if (!latest) {
    requestCache.set(ck, null);
    return null;
  }
  const value = await fetchUrl(latest.url);
  requestCache.set(ck, value);
  return value;
}

// ============================================================
// Public API: write/delete
// ============================================================

// Write content with a random suffix, then sweep older versions so we
// don't accumulate garbage. `keepOlder` is the number of older versions
// to retain (default 0 = keep only the latest).
async function writeContent(name, id, value, { keepOlder = KEEP_OLDEST_VERSIONS } = {}) {
  const body = JSON.stringify(value, null, 2) + "\n";
  const result = await put(contentPathStem(name, id), body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: true,
    token: TOKEN,
    cacheControlMaxAge: 0,
  });
  // Sweep older versions. Best-effort; if a delete fails we'll retry on
  // the next write. We compare by URL so we don't accidentally delete the
  // version we just wrote. We use the broad row prefix
  // (`${name}/${id}`) so we catch both the random-suffix V3 versions and
  // the legacy V2 stable-pathname version.
  try {
    const blobs = await paginatedList(`${BLOB_PREFIX}${name}/${id}`);
    const idPrefix = ID_PREFIXES[name];
    const versions = blobs
      .filter((b) => isContentBlob(b.pathname))
      // Only blobs whose extracted id equals this row's id. Defensive
      // against id collisions like t-1 vs t-10 sharing a prefix.
      .filter((b) => extractIdFromContentPath(b.pathname, idPrefix) === id)
      .filter((b) => b.url !== result.url)
      .sort((a, b) => +b.uploadedAt - +a.uploadedAt);
    const toDelete = versions.slice(keepOlder);
    if (toDelete.length > 0) {
      await Promise.all(toDelete.map((b) =>
        del(b.url, { token: TOKEN }).catch((err) => {
          console.warn(`[store] could not delete stale version ${b.pathname}: ${err.message}`);
        })
      ));
    }
  } catch (err) {
    console.warn(`[store] could not sweep stale versions for ${name}/${id}: ${err.message}`);
  }
  return { value, url: result.url };
}

// Overwrite an existing row, or create a new one if missing (without ID
// uniqueness checks — caller must already know the ID is theirs).
export async function writeRow(name, id, value) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection ${name}`);
  await writeContent(name, id, value);
  requestCache.set(rowCacheKey(name, id), value);
  requestCache.delete(listCacheKey(name));
}

export async function deleteRow(name, id) {
  if (!COLLECTIONS.includes(name)) return;
  // Delete the lock and all content versions in parallel.
  const blobs = await paginatedList(`${BLOB_PREFIX}${name}/${id}`);
  await Promise.all(blobs.map((b) =>
    del(b.url, { token: TOKEN }).catch((err) => {
      if (err?.status === 404 || /not found/i.test(err?.message || "")) return;
      throw err;
    })
  ));
  requestCache.delete(rowCacheKey(name, id));
  requestCache.delete(listCacheKey(name));
}

// In-place mutation of a single row.
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
// ID generation for new rows (POST)
// ============================================================

function paddedId(prefix, n) {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

function isLockConflictError(err) {
  if (!err) return false;
  if (err.name === "BlobAccessError") return true;
  const msg = String(err.message || "");
  return /already exists|allowOverwrite|overwrite/i.test(msg);
}

async function listExistingIdNumsForCollection(name) {
  const idPrefix = ID_PREFIXES[name];
  if (!idPrefix) return [];
  const blobs = await paginatedList(collectionContentPrefix(name));
  const lockRe = new RegExp(`/${idPrefix}-(\\d+)\\.lock$`);
  const contentRe = new RegExp(`/${idPrefix}-(\\d+)-[A-Za-z0-9]+\\.json$`);
  const legacyV2Re = new RegExp(`/${idPrefix}-(\\d+)\\.json$`);
  const nums = new Set();
  for (const b of blobs) {
    let m = b.pathname.match(lockRe);
    if (m) { nums.add(parseInt(m[1], 10)); continue; }
    m = b.pathname.match(contentRe);
    if (m) { nums.add(parseInt(m[1], 10)); continue; }
    m = b.pathname.match(legacyV2Re);
    if (m) nums.add(parseInt(m[1], 10));
  }
  return [...nums];
}

// Create a new row with an auto-assigned ID. Race-safe: the lock file
// PUT with allowOverwrite=false is an atomic origin-side create-or-fail,
// so two concurrent POSTs that compute the same candidate ID can't both
// win.
export async function createRow(name, buildValue) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection ${name}`);
  const idPrefix = ID_PREFIXES[name];
  if (!idPrefix) throw new Error(`no id prefix for collection ${name}`);

  const existingNums = await listExistingIdNumsForCollection(name);
  let candidate = (existingNums.length ? Math.max(...existingNums) : 0) + 1;

  for (let attempt = 0; attempt < ID_RETRY_LIMIT; attempt++) {
    const id = paddedId(idPrefix, candidate);
    // Try to acquire the lock for this ID.
    try {
      await put(lockPath(name, id), `${id}\n`, {
        access: "public",
        contentType: "text/plain",
        addRandomSuffix: false,
        allowOverwrite: false,
        token: TOKEN,
        cacheControlMaxAge: 0,
      });
    } catch (err) {
      if (!isLockConflictError(err)) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      candidate++;
      continue;
    }
    // Lock acquired. Build the value, write content.
    const value = buildValue(id);
    await writeContent(name, id, value);
    requestCache.set(rowCacheKey(name, id), value);
    requestCache.delete(listCacheKey(name));
    return value;
  }
  throw new Error(`createRow(${name}) exceeded ${ID_RETRY_LIMIT} ID retries`);
}

// ============================================================
// Compatibility shims
// ============================================================

export async function readCollection(name) {
  return listRows(name);
}

export function isBlobConfigured() {
  return Boolean(TOKEN);
}
