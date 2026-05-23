#!/usr/bin/env node
// One-shot migration: uploads local data/*.json files into Vercel Blob.
//
// Usage:
//   1) `vercel env pull .env.local` to grab BLOB_READ_WRITE_TOKEN
//   2) `node scripts/migrate-to-blob.mjs`
//
// Or pass the token directly:
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/migrate-to-blob.mjs
//
// The script reads each JSON file under ./data/, validates it parses, and
// writes it to Blob under the same path the API uses (ai-slaves/<name>.json).

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { put } from "@vercel/blob";

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

async function loadEnvLocal() {
  // Lazy reader to avoid a dotenv dep. Only reads .env.local if it exists.
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

async function main() {
  await loadEnvLocal();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error(
      "BLOB_READ_WRITE_TOKEN not set. Run `vercel env pull .env.local` first."
    );
    process.exit(1);
  }

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const name of COLLECTIONS) {
    const file = path.join(ROOT, "data", `${name}.json`);
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        console.log(`[skip] ${name}: file not found`);
        skipCount++;
        continue;
      }
      console.error(`[fail] ${name}: ${err.message}`);
      failCount++;
      continue;
    }

    try {
      JSON.parse(raw);
    } catch (err) {
      console.error(`[fail] ${name}: invalid JSON, ${err.message}`);
      failCount++;
      continue;
    }

    const key = `${BLOB_PREFIX}${name}.json`;
    try {
      const result = await put(key, raw, {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        token,
        cacheControlMaxAge: 0,
      });
      const size = (raw.length / 1024).toFixed(1);
      console.log(`[ok]   ${name}: ${size} KB -> ${result.url}`);
      okCount++;
    } catch (err) {
      console.error(`[fail] ${name}: blob put failed, ${err.message}`);
      failCount++;
    }
  }

  console.log(
    `\nDone. ${okCount} uploaded, ${skipCount} skipped, ${failCount} failed.`
  );
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
