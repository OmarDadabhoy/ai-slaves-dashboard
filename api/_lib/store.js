// Storage layer for the Vercel deployment. Local mode uses ./data/*.json
// directly in server.js; this file is only loaded by api/ serverless functions.
//
// Backend: Vercel Blob (https://vercel.com/docs/storage/vercel-blob). One blob
// per collection (tasks, suggested_changes, etc.). Reads use the public URL of
// the latest version; writes overwrite the blob via the @vercel/blob put().
//
// Concurrency: Vercel functions are short-lived and stateless, so we re-read
// the blob on every mutation, apply the change, write back. This is a
// last-write-wins model. For the single-user dashboard that's acceptable;
// the orchestrator and the dashboard rarely race on the same row.
//
// Token: BLOB_READ_WRITE_TOKEN is provisioned automatically by Vercel when a
// Blob store is linked to the project (or supplied via `vercel blob create-store`).

import { put, list, head } from "@vercel/blob";

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

function blobKey(name) {
  return `${BLOB_PREFIX}${name}.json`;
}

// In-process cache to dedupe blob fetches inside a single function invocation
// (different routes may hit the same collection multiple times per request).
const requestCache = new Map();
function cacheKey(name) {
  return `c:${name}`;
}

async function fetchCollectionFromBlob(name) {
  const key = blobKey(name);
  try {
    // `list` with prefix scoped to this collection's key; cheaper than head().
    const r = await list({ prefix: key, limit: 1, token: TOKEN });
    if (!r.blobs || r.blobs.length === 0) return [];
    // Vercel Blob public URLs are CDN-cached at the edge. Even with
    // cacheControlMaxAge:0 on write, edge nodes can serve stale snapshots
    // for a brief window. Append a unique timestamp to bypass edge cache
    // and always read the origin's current bytes. (Fixes the "tickets
    // appear/disappear in the UI" flicker.)
    const url = r.blobs[0].url + (r.blobs[0].url.includes("?") ? "&" : "?") + `ts=${Date.now()}`;
    const fetched = await fetch(url, { cache: "no-store" });
    if (!fetched.ok) return [];
    const raw = await fetched.text();
    if (!raw.trim()) return [];
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error(`[store] parse failed for ${name}:`, err.message);
      return [];
    }
  } catch (err) {
    // If the blob doesn't exist yet, that's a fresh collection.
    if (err?.status === 404) return [];
    console.error(`[store] read failed for ${name}:`, err.message);
    return [];
  }
}

export async function readCollection(name) {
  if (!COLLECTIONS.includes(name)) return [];
  const ck = cacheKey(name);
  if (requestCache.has(ck)) return requestCache.get(ck);
  const items = await fetchCollectionFromBlob(name);
  requestCache.set(ck, items);
  return items;
}

export async function writeCollection(name, items) {
  if (!COLLECTIONS.includes(name)) {
    throw new Error(`unknown collection ${name}`);
  }
  const key = blobKey(name);
  const body = JSON.stringify(items, null, 2) + "\n";
  // allowOverwrite=true so put() replaces the existing object instead of
  // creating a new URL each time. addRandomSuffix=false matches the same goal.
  await put(key, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    token: TOKEN,
    cacheControlMaxAge: 0,
  });
  // Update cache so the same invocation sees the new value.
  requestCache.set(cacheKey(name), items);
}

export function clearRequestCache() {
  requestCache.clear();
}

// Atomic mutate-and-save helper with optimistic concurrency control.
//
// Vercel Blob has no native compare-and-set, so we approximate it: capture
// the blob's `uploadedAt` before the read, do the mutation, re-check
// `uploadedAt` before the write, and if it changed (another writer landed
// in between), bust the cache and retry with the new state.
//
// This catches the common race: two writers each read the same snapshot,
// modify it locally, and write back. Without this guard the second writer
// silently overwrites the first writer's change.
const MUTATE_RETRIES = 6;
async function blobHeadUploadedAt(name) {
  const key = blobKey(name);
  try {
    const r = await list({ prefix: key, limit: 1, token: TOKEN });
    if (!r.blobs || r.blobs.length === 0) return null;
    return r.blobs[0].uploadedAt || r.blobs[0].url || null;
  } catch { return null; }
}

export async function mutateCollection(name, mutator) {
  let lastErr = null;
  for (let attempt = 0; attempt < MUTATE_RETRIES; attempt++) {
    const beforeStamp = await blobHeadUploadedAt(name);
    requestCache.delete(cacheKey(name)); // force fresh read from origin
    const items = await readCollection(name);
    const mutation = await mutator(items);
    if (mutation.skipWrite) return mutation.result;
    // Re-check the blob's stamp right before writing. If it moved, someone
    // else wrote between our read and our write; retry with fresh state.
    const recheckStamp = await blobHeadUploadedAt(name);
    if (beforeStamp !== null && recheckStamp !== null && recheckStamp !== beforeStamp) {
      requestCache.delete(cacheKey(name));
      // Short backoff with jitter so concurrent writers don't lock-step.
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 70));
      lastErr = new Error(`stale read on ${name} (attempt ${attempt + 1})`);
      continue;
    }
    await writeCollection(name, mutation.items || items);
    return mutation.result;
  }
  // Last-resort: write anyway so the caller doesn't hang. Logged so we can
  // see contention. In practice this almost never fires.
  console.error(`[store] mutateCollection ${name} exceeded retries: ${lastErr?.message}`);
  const items = await readCollection(name);
  const mutation = await mutator(items);
  if (mutation.skipWrite) return mutation.result;
  await writeCollection(name, mutation.items || items);
  return mutation.result;
}

export function isBlobConfigured() {
  return Boolean(TOKEN);
}
