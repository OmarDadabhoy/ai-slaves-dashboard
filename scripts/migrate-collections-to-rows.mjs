#!/usr/bin/env node
// One-shot migration: splits each per-collection blob into per-row blobs.
//
// Old shape:  ai-slaves/<name>.json           (single blob, JSON array)
// New shape:  ai-slaves/<name>/<id>.json      (one blob per row)
//
// Idempotent: if a row blob already exists at the new path, it's left alone
// (we don't overwrite, so re-running this script after live writes can't
// clobber fresh state).
//
// After every row from a collection has been migrated successfully, the
// old collection blob can be deleted to remove the source of races.
// Pass --delete-old to do that.
//
// Usage:
//   1) `vercel env pull .env.local` to grab BLOB_READ_WRITE_TOKEN
//   2) `node scripts/migrate-collections-to-rows.mjs`
//      (add `--dry-run` to print the plan without writing)
//      (add `--delete-old` to remove the legacy collection blob after success)
//
// Or pass the token directly:
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/migrate-collections-to-rows.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put, list, del } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BLOB_PREFIX = process.env.BLOB_PREFIX || "ai-slaves/";

const COLLECTIONS = [
  "tasks",
  "suggested_changes",
  "followups",
  "done_log",
  "agents",
  "pending_drains",
  "scheduled",
];

const DRY_RUN = process.argv.includes("--dry-run");
const DELETE_OLD = process.argv.includes("--delete-old");

async function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, key, value] = m;
      if (!process.env[key]) {
        process.env[key] = value.replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {}
}

async function fetchCollectionBlob(name, token) {
  const key = `${BLOB_PREFIX}${name}.json`;
  const r = await list({ prefix: key, limit: 1, token });
  if (!r.blobs || r.blobs.length === 0) return { blob: null, items: [] };
  const blob = r.blobs[0];
  // ts cache-bust for the read.
  const url = blob.url + (blob.url.includes("?") ? "&" : "?") + `ts=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`fetch ${key} returned ${resp.status}`);
  const raw = await resp.text();
  if (!raw.trim()) return { blob, items: [] };
  return { blob, items: JSON.parse(raw) };
}

async function listExistingRows(name, token) {
  const prefix = `${BLOB_PREFIX}${name}/`;
  const out = new Set();
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await list({ prefix, limit: 1000, cursor, token });
    if (r.blobs) {
      for (const b of r.blobs) {
        const m = b.pathname.match(/\/([^/]+)\.json$/);
        if (m) out.add(m[1]);
      }
    }
    if (!r.cursor || !r.hasMore) break;
    cursor = r.cursor;
  }
  return out;
}

async function writeRow(name, id, value, token) {
  const key = `${BLOB_PREFIX}${name}/${id}.json`;
  const body = JSON.stringify(value, null, 2) + "\n";
  await put(key, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: false, // never clobber existing rows
    token,
    cacheControlMaxAge: 0,
  });
}

async function migrateCollection(name, token) {
  console.log(`\n=== ${name} ===`);
  const { blob, items } = await fetchCollectionBlob(name, token);
  if (!blob) {
    console.log(`[skip] no legacy blob at ${BLOB_PREFIX}${name}.json`);
    return { wrote: 0, skipped: 0, errors: 0, oldBlobDeleted: false };
  }
  if (!Array.isArray(items)) {
    console.log(`[fail] ${name}: legacy blob is not an array`);
    return { wrote: 0, skipped: 0, errors: 1, oldBlobDeleted: false };
  }
  console.log(`legacy blob has ${items.length} items`);

  const existing = await listExistingRows(name, token);
  console.log(`existing per-row blobs: ${existing.size}`);

  let wrote = 0;
  let skipped = 0;
  let errors = 0;
  const concurrency = 16;
  const queue = [...items];

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const id = item?.id;
      if (!id) {
        console.warn(`[skip] item without id:`, JSON.stringify(item).slice(0, 120));
        skipped++;
        continue;
      }
      if (existing.has(id)) {
        skipped++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`[dry] would write ${BLOB_PREFIX}${name}/${id}.json`);
        wrote++;
        continue;
      }
      try {
        await writeRow(name, id, item, token);
        wrote++;
        if (wrote % 50 === 0) {
          console.log(`  ... wrote ${wrote}, ${queue.length} remaining`);
        }
      } catch (err) {
        // If a race put the same row in place since we listed, treat as ok.
        if (/already exists|allowOverwrite|overwrite/i.test(err?.message || "")) {
          skipped++;
        } else {
          console.error(`[fail] ${name}/${id}: ${err.message}`);
          errors++;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`done: wrote=${wrote} skipped=${skipped} errors=${errors}`);

  let oldBlobDeleted = false;
  if (DELETE_OLD && !DRY_RUN && errors === 0 && blob) {
    try {
      await del(blob.url, { token });
      oldBlobDeleted = true;
      console.log(`[delete] removed legacy blob ${blob.pathname}`);
    } catch (err) {
      console.error(`[fail] could not delete legacy blob: ${err.message}`);
    }
  } else if (DELETE_OLD && errors > 0) {
    console.warn(`[hold] not deleting legacy blob because errors > 0`);
  }

  return { wrote, skipped, errors, oldBlobDeleted };
}

async function main() {
  await loadEnvLocal();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error("BLOB_READ_WRITE_TOKEN not set. Run `vercel env pull .env.local` first.");
    process.exit(1);
  }
  if (DRY_RUN) console.log("** DRY RUN: no writes will happen **");
  if (DELETE_OLD) console.log("** DELETE_OLD set: legacy collection blobs will be removed after success **");

  let totalWrote = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalDeleted = 0;
  for (const name of COLLECTIONS) {
    const r = await migrateCollection(name, token);
    totalWrote += r.wrote;
    totalSkipped += r.skipped;
    totalErrors += r.errors;
    if (r.oldBlobDeleted) totalDeleted++;
  }
  console.log("\n=== SUMMARY ===");
  console.log(`wrote:           ${totalWrote}`);
  console.log(`skipped:         ${totalSkipped}`);
  console.log(`errors:          ${totalErrors}`);
  console.log(`legacy deleted:  ${totalDeleted}`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
