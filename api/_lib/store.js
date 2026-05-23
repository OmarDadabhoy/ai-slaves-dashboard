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
    const url = r.blobs[0].url;
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

// Atomic mutate-and-save helper. Reads the latest, lets the mutator return
// either { items, result } or { skipWrite, result }.
export async function mutateCollection(name, mutator) {
  const items = await readCollection(name);
  const mutation = await mutator(items);
  if (mutation.skipWrite) return mutation.result;
  await writeCollection(name, mutation.items || items);
  return mutation.result;
}

export function isBlobConfigured() {
  return Boolean(TOKEN);
}
