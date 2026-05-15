// Express server backing the AI Slaves Power Doc dashboard.
// JSON files in ./data are the source of truth.
// Reads/writes are atomic-per-call. The orchestrator (the /ai-slaves drain) mirrors writes here
// in parallel with the Google Doc when this server is reachable. See SKILL.md "Dashboard mirror".

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

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
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

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

const PORT = process.env.PORT || 5176;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`AI Slaves Power Doc API listening on http://${HOST}:${PORT}`);
});
