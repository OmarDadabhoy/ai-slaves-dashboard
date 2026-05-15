// Express server backing the AI Slaves Power Doc dashboard.
// JSON files in ./data are the source of truth.
// Reads/writes are atomic-per-call. The orchestrator (the /ai-slaves drain) mirrors writes here
// in parallel with the Google Doc when this server is reachable. See SKILL.md "Dashboard mirror".

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(__dirname, "logs");

const FILES = {
  tasks: path.join(DATA_DIR, "tasks.json"),
  suggested_changes: path.join(DATA_DIR, "suggested_changes.json"),
  followups: path.join(DATA_DIR, "followups.json"),
  done_log: path.join(DATA_DIR, "done_log.json"),
  agents: path.join(DATA_DIR, "agents.json"),
  pending_drains: path.join(DATA_DIR, "pending_drains.json"),
};

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw || !raw.trim()) return [];
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      console.error(`[readJson] parse failed for ${file} (size=${raw.length}), returning []:`, parseErr.message);
      return [];
    }
  } catch (err) {
    if (err.code === "ENOENT") return [];
    console.error(`[readJson] io failed for ${file}:`, err.message);
    return [];
  }
}

let writeCounter = 0;
const writeLocks = new Map();
async function writeJson(file, data) {
  // Serialize concurrent writes to the same file. Each call queues on the
  // previous one so we never get tmp-rename collisions or lost updates.
  const prev = writeLocks.get(file) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  writeLocks.set(file, prev.then(() => next));
  try {
    await prev;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${++writeCounter}.${Math.random().toString(36).slice(2,8)}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  } finally {
    release();
    // Garbage-collect the lock chain when this is the tail.
    if (writeLocks.get(file) === next.then(() => undefined)) writeLocks.delete(file);
  }
}

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

function nextId(prefix, items) {
  const nums = items
    .map((i) => {
      const m = String(i.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => !Number.isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function statusDefault(name) {
  if (name === "tasks") return "queued";
  if (name === "suggested_changes") return "pending";
  if (name === "agents") return "running";
  if (name === "pending_drains") return "pending";
  return undefined;
}

// Back-compat: SKILL.md and old seed data use `todo`. UI uses `queued`.
// Normalize on read so both sources agree.
function normalizeTask(t) {
  if (!t) return t;
  if (t.status === "todo") t.status = "queued";
  if (!t.text && t.title) t.text = t.title;
  return t;
}

const app = express();
app.use(cors());
app.use(express.json());

function collection(name, file, idPrefix, normalize) {
  app.get(`/api/${name}`, async (_req, res) => {
    let items = await readJson(file);
    if (normalize) items = items.map(normalize);
    res.json(items);
  });

  app.post(`/api/${name}`, async (req, res) => {
    const items = await readJson(file);
    const body = req.body || {};
    const item = {
      id: nextId(idPrefix, items),
      created_at: new Date().toISOString(),
      ...body,
    };
    const def = statusDefault(name);
    if (def && !item.status) item.status = def;
    if (normalize) normalize(item);
    items.unshift(item);
    await writeJson(file, items);
    res.json(item);
  });

  app.patch(`/api/${name}/:id`, async (req, res) => {
    const items = await readJson(file);
    const idx = items.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "not found" });
    items[idx] = { ...items[idx], ...req.body };
    if (normalize) normalize(items[idx]);
    await writeJson(file, items);
    res.json(items[idx]);
  });

  app.delete(`/api/${name}/:id`, async (req, res) => {
    const items = await readJson(file);
    const filtered = items.filter((i) => i.id !== req.params.id);
    await writeJson(file, filtered);
    res.json({ ok: true });
  });

  // Bulk delete: POST /api/<name>/_bulk_delete { ids?: [...], where?: {status:"done"} }
  // One read + one write. Replaces N parallel DELETE calls so concurrent
  // Clear-all-style buttons can't race the JSON file.
  app.post(`/api/${name}/_bulk_delete`, async (req, res) => {
    const items = await readJson(file);
    const idSet = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
    const where = req.body?.where && typeof req.body.where === "object" ? req.body.where : null;
    const filtered = items.filter((i) => {
      if (idSet.has(i.id)) return false;
      if (where) {
        for (const k of Object.keys(where)) {
          if (i[k] !== where[k]) return true;
        }
        return false;
      }
      return true;
    });
    const deleted = items.length - filtered.length;
    await writeJson(file, filtered);
    res.json({ ok: true, deleted, remaining: filtered.length });
  });
}

collection("tasks", FILES.tasks, "t", normalizeTask);
collection("suggested_changes", FILES.suggested_changes, "sc");
collection("followups", FILES.followups, "fu");
collection("done_log", FILES.done_log, "dl");
collection("agents", FILES.agents, "ag");
collection("pending_drains", FILES.pending_drains, "pd");

// Convenience: promote a Suggested Change into a queued ticket in one call.
app.post("/api/suggested_changes/:id/promote", async (req, res) => {
  const scs = await readJson(FILES.suggested_changes);
  const sc = scs.find((s) => s.id === req.params.id);
  if (!sc) return res.status(404).json({ error: "not found" });
  const tasks = await readJson(FILES.tasks);
  const ticket = {
    id: nextId("t", tasks),
    created_at: new Date().toISOString(),
    text: sc.text || sc.title || "(no text)",
    status: "queued",
    cycle: sc.cycle,
    promoted_from: sc.id,
  };
  tasks.unshift(ticket);
  await writeJson(FILES.tasks, tasks);
  // mark SC promoted
  const idx = scs.findIndex((s) => s.id === req.params.id);
  scs[idx] = { ...scs[idx], status: "promoted", promoted_to: ticket.id };
  await writeJson(FILES.suggested_changes, scs);
  res.json({ ticket, sc: scs[idx] });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Fire a drain via `claude` in stream-json mode (long-lived session pattern, no `-p`).
// `-p`/--print is on Anthropic's deprecation watch; the streaming stdin/stdout pattern
// matches the claude-heartbeat approach (Siigari/claude-heartbeat): the process stays
// alive, prompts arrive via stdin as NDJSON, output streams back as NDJSON, and the
// completion signal is a `{"type":"result", ...}` line. We spawn detached so the HTTP
// response returns instantly while the drain keeps running.
//
// Each drain run is its own session (the orchestrator wants a clean context per cycle).
// The same wrapper would let us add a true persistent process later if we want to share
// context across drains; for now per-run sessions match the existing UX.
function resolveClaudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return "claude"; // fall back to PATH
}

// Spawn a long-lived claude stream-json session. Returns { child, logPath, mode }.
// stdio: stdin = pipe (we write a user message NDJSON line), stdout/stderr = piped to log.
function spawnClaudeStreamSession({ claudeBin, cwd, prompt, logPath }) {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", // required by claude when using stream-json output
    "--dangerously-skip-permissions",
  ];
  const child = spawn(claudeBin, args, {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const logStream = createWriteStream(logPath, { flags: "a" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (err) => {
    try { logStream.write(`\n# spawn error: ${err.message}\n`); } catch {}
  });

  // Send the prompt as a stream-json user message, then close stdin so claude
  // knows no more input is coming. The session itself keeps running until the
  // result line + end_turn fire.
  const userMsg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  };
  try {
    child.stdin.write(JSON.stringify(userMsg) + "\n");
    child.stdin.end();
  } catch (err) {
    try { logStream.write(`\n# stdin write error: ${err.message}\n`); } catch {}
  }
  child.unref();
  return { child, mode: "stream-json" };
}

app.post("/api/drain/run", async (req, res) => {
  const prompt = (req.body && req.body.prompt) || "/ai-slaves";
  const claudeBin = resolveClaudeBin();
  const cwd = (req.body && req.body.cwd) || os.homedir();
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    const startedAt = new Date().toISOString();
    const logPath = path.join(LOGS_DIR, `drain-${Date.now()}.log`);
    // Header up-front, then the spawn appends its stream-json output to the same file.
    await fs.writeFile(
      logPath,
      `# drain fire ${startedAt}\n# bin: ${claudeBin}\n# mode: stream-json (no -p)\n# prompt: ${prompt}\n# cwd: ${cwd}\n\n`,
      "utf8"
    );
    const { child, mode } = spawnClaudeStreamSession({
      claudeBin,
      cwd,
      prompt,
      logPath,
    });

    // Mirror to pending_drains so the UI list still shows what happened.
    try {
      const items = await readJson(FILES.pending_drains);
      const item = {
        id: nextId("pd", items),
        status: "fired",
        requested_at: startedAt,
        note: `direct fire via /api/drain/run, ${mode} (PID ${child.pid})`,
        pid: child.pid,
        log_path: logPath,
        mode,
      };
      items.unshift(item);
      await writeJson(FILES.pending_drains, items);
    } catch (e) {
      // non-fatal
    }

    res.json({
      ok: true,
      pid: child.pid,
      log_path: logPath,
      bin: claudeBin,
      mode,
      started_at: startedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5176;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`AI Slaves Power Doc API listening on http://${HOST}:${PORT}`);
});
