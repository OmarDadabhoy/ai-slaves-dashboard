import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}\n${logs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy: ${lastError?.message || "timeout"}\n${logs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(1000).then(() => child.kill("SIGKILL")),
  ]);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-slaves-dashboard-data-"));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";

const child = spawn(process.execPath, ["server.js"], {
  cwd: rootDir,
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

try {
  await waitForHealth(baseUrl, child, () => output);
  const [first, second] = await Promise.all([
    postJson(`${baseUrl}/api/suggested_changes`, { text: "concurrent verifier A" }),
    postJson(`${baseUrl}/api/suggested_changes`, { text: "concurrent verifier B" }),
  ]);

  const ids = [first.id, second.id];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`duplicate ids returned: ${ids.join(", ")}`);
  }

  const rowsRes = await fetch(`${baseUrl}/api/suggested_changes`);
  if (!rowsRes.ok) throw new Error(`GET suggested_changes returned ${rowsRes.status}`);
  const rows = await rowsRes.json();
  const persisted = new Set(rows.map((row) => row.id));
  for (const id of ids) {
    if (!persisted.has(id)) throw new Error(`missing persisted row for ${id}`);
  }

  console.log(`ok: concurrent POSTs returned ${ids.join(", ")} and ${rows.length} rows persisted`);
} finally {
  await stopChild(child);
  await fs.rm(dataDir, { recursive: true, force: true });
}
