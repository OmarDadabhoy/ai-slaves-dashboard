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
import { spawn, spawnSync } from "child_process";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const LOGS_DIR = path.join(__dirname, "logs");
// Reports dir holds the per-task handoff HTMLs that the /ai-slaves drain writes.
// Stable absolute path under ~/Desktop; matches the orchestrator's write target.
const REPORTS_DIR = path.join(os.homedir(), "Desktop", "Ai-slaves", "state", "reports");
// Only the persistent reports dir is allowed for /api/local_report. /tmp and
// /private/tmp are intentionally excluded — handoff HTMLs must live under the
// stable ~/Desktop/Ai-slaves/state/reports/ root so links don't 404 after reboot.
const LOCAL_REPORT_ROOTS = [REPORTS_DIR];
const SCHEDULER_PID_FILE = path.join(__dirname, ".scheduler.pid");
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

const FILES = {
  tasks: path.join(DATA_DIR, "tasks.json"),
  suggested_changes: path.join(DATA_DIR, "suggested_changes.json"),
  followups: path.join(DATA_DIR, "followups.json"),
  done_log: path.join(DATA_DIR, "done_log.json"),
  agents: path.join(DATA_DIR, "agents.json"),
  pending_drains: path.join(DATA_DIR, "pending_drains.json"),
  // Manually-maintained registry of scheduled work (in-session crons + remote
  // /schedule routines). v1 is hand-populated; future skills can POST entries
  // when they create scheduled jobs so this view stays in sync.
  scheduled: path.join(DATA_DIR, "scheduled.json"),
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
const fileLocks = new Map();

async function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => {}).then(() => current);
  fileLocks.set(file, tail);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  }
}

async function withFileLocks(files, fn) {
  const ordered = [...new Set(files)].sort();
  let index = 0;
  const run = () => {
    if (index >= ordered.length) return fn();
    const file = ordered[index++];
    return withFileLock(file, run);
  };
  return run();
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${++writeCounter}.${Math.random().toString(36).slice(2,8)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

async function mutateJson(file, mutator) {
  return withFileLock(file, async () => {
    const items = await readJson(file);
    const mutation = await mutator(items);
    if (mutation.skipWrite) return mutation.result;
    await writeJson(file, mutation.items || items);
    return mutation.result;
  });
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
  if (name === "scheduled") return "enabled";
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

const SEND_REVIEW_CHECKLIST_KIND = "gmail_send_review_checklist";

function followupText(item) {
  return String(item?.text || item?.question || item?.title || "").trim();
}

function compactLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function extractDraftId(text) {
  const m = text.match(/\bDraft\s+([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function extractSubject(text) {
  const m = text.match(/\bSubject:\s*([^.\n]+)/i);
  return m ? compactLine(m[1]) : null;
}

function isSendReviewDraftFollowup(item) {
  if (!item || item.kind === SEND_REVIEW_CHECKLIST_KIND) return false;
  if (item.decision || item.send_review_grouped_into) return false;
  if (["done", "decided", "dropped", "grouped"].includes(item.status)) return false;

  const text = followupText(item);
  const lower = text.toLowerCase();
  if (!lower || !/\bdrafts?\b/.test(lower)) return false;
  if (!/\b(send|sending|sent)\b|review\/send|review and send|before sending|drafts folder/.test(lower)) {
    return false;
  }
  if (/auth login|restore .*draft|draft access|gmail filter|oauth|credential|token/.test(lower)) {
    return false;
  }

  const gmailish = /\bgmail\b|drafts folder|\bdraft\s+r-\d+/.test(lower);
  const followupish =
    /follow[- ]?up|bump|warm[- ]?intro|same[- ]?thread|signup|customer|legalos|businessrocket|vector legal|deel/.test(lower);
  return gmailish || followupish || /\bapproved\b/.test(lower);
}

function sendReviewChecklistItem(item) {
  const text = followupText(item);
  return {
    id: item.id,
    followup_id: item.id,
    text: compactLine(text),
    draft_id: extractDraftId(text),
    subject: extractSubject(text),
    cycle: item.cycle,
    created_at: item.created_at,
    handoff: item.handoff_path || item.handoff || null,
  };
}

function sendReviewChecklistText(count) {
  const noun = count === 1 ? "draft" : "drafts";
  return `Gmail send-review checklist: ${count} approved ${noun} ready for review. Open each draft in Gmail, check it here after review, then send from Gmail when ready.`;
}

function relPath(file) {
  if (!file) return file;
  const rel = path.relative(__dirname, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isUnderRoot(file, root) {
  const rel = path.relative(root, file);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function parseLocalReportPath(raw) {
  const value = String(raw || "").trim();
  if (!value) throw httpError(400, "missing path");
  if (/^https?:\/\//i.test(value)) throw httpError(400, "remote report URLs are not local files");
  if (/^file:\/\//i.test(value)) return fileURLToPath(value);
  if (path.isAbsolute(value)) return value;

  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.startsWith("state/reports/")) {
    return path.join(os.homedir(), "Desktop", "Ai-slaves", normalized);
  }
  return path.join(REPORTS_DIR, path.basename(normalized));
}

async function resolveLocalReportFile(raw) {
  let requested;
  try {
    requested = parseLocalReportPath(raw);
  } catch (err) {
    if (err.status) throw err;
    throw httpError(400, "bad file URL");
  }
  if (!requested.toLowerCase().endsWith(".html")) {
    throw httpError(400, "only HTML reports can be served");
  }

  let realFile;
  try {
    realFile = await fs.realpath(path.resolve(requested));
  } catch (err) {
    if (err.code === "ENOENT") throw httpError(404, "report not found");
    throw err;
  }

  const roots = await Promise.all(
    LOCAL_REPORT_ROOTS.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return null;
      }
    })
  );
  if (!roots.filter(Boolean).some((root) => isUnderRoot(realFile, root))) {
    throw httpError(403, "report path is outside allowed report directories");
  }
  return realFile;
}

function decodeXml(s) {
  return String(s || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function plistString(raw, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`);
  const m = raw.match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function plistInteger(raw, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`);
  const m = raw.match(re);
  return m ? Number(m[1]) : null;
}

function plistArray(raw, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`);
  const m = raw.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) =>
    decodeXml(x[1].trim())
  );
}

async function fileMeta(file) {
  try {
    const st = await fs.stat(file);
    return {
      path: file,
      relative_path: relPath(file),
      exists: true,
      size: st.size,
      mtime_iso: st.mtime.toISOString(),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        path: file,
        relative_path: relPath(file),
        exists: false,
      };
    }
    return {
      path: file,
      relative_path: relPath(file),
      exists: false,
      error: err.message,
    };
  }
}

function processField(pid, field) {
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.status === 0) return out.stdout.trim();
  } catch {}
  return "";
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseIntervalFromCommand(command) {
  if (!command) return {};
  const interval = command.match(/sleep\s+\$\(\(\s*(\d+)\s*\+\s*jitter\s*\)\)/);
  const jitter = command.match(/RANDOM\s*%\s*(\d+)/);
  return {
    interval_seconds: interval ? Number(interval[1]) : null,
    jitter_seconds: jitter ? Math.max(0, Number(jitter[1]) - 1) : null,
  };
}

function launchctlInfo(label) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const target = uid == null ? label : `gui/${uid}/${label}`;
  try {
    const out = spawnSync("launchctl", ["print", target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.status !== 0 || !out.stdout) return { loaded: false };
    const text = out.stdout;
    const value = (pattern) => {
      const m = text.match(pattern);
      return m ? m[1].trim() : null;
    };
    const numberValue = (pattern) => {
      const v = value(pattern);
      return v == null ? null : Number(v);
    };
    return {
      loaded: true,
      state: value(/state = ([^\n]+)/),
      runs: numberValue(/runs = (\d+)/),
      last_exit_code: numberValue(/last exit code = (-?\d+)/),
      run_interval_seconds: numberValue(/run interval = (\d+) seconds/),
    };
  } catch {
    return { loaded: false };
  }
}

async function discoverLaunchAgents() {
  let names = [];
  try {
    names = await fs.readdir(LAUNCH_AGENTS_DIR);
  } catch {
    return [];
  }
  const agents = [];
  for (const name of names.filter((n) => n.endsWith(".plist")).sort()) {
    const full = path.join(LAUNCH_AGENTS_DIR, name);
    let raw = "";
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const label = plistString(raw, "Label") || name.replace(/\.plist$/, "");
    if (!/ai-slaves/i.test(label) && !/\/api\/drain\/run/i.test(raw)) continue;
    const program_arguments = plistArray(raw, "ProgramArguments");
    const agent = {
      label,
      path: full,
      relative_path: full,
      start_interval_seconds: plistInteger(raw, "StartInterval"),
      stdout_path: plistString(raw, "StandardOutPath"),
      stderr_path: plistString(raw, "StandardErrorPath"),
      process_type: plistString(raw, "ProcessType"),
      program_arguments,
      command: program_arguments.join(" "),
      launchctl: launchctlInfo(label),
    };
    agents.push(agent);
  }
  return agents;
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
    const body = req.body || {};
    const item = await mutateJson(file, async (items) => {
      const next = {
        id: nextId(idPrefix, items),
        created_at: new Date().toISOString(),
        ...body,
      };
      const def = statusDefault(name);
      if (def && !next.status) next.status = def;
      if (normalize) normalize(next);
      items.unshift(next);
      return { result: next };
    });
    res.json(item);
  });

  app.patch(`/api/${name}/:id`, async (req, res) => {
    const item = await mutateJson(file, async (items) => {
      const idx = items.findIndex((i) => i.id === req.params.id);
      if (idx === -1) return { skipWrite: true, result: null };
      items[idx] = { ...items[idx], ...req.body };
      if (normalize) normalize(items[idx]);
      return { result: items[idx] };
    });
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  });

  app.delete(`/api/${name}/:id`, async (req, res) => {
    const result = await mutateJson(file, async (items) => ({
      items: items.filter((i) => i.id !== req.params.id),
      result: { ok: true },
    }));
    res.json(result);
  });

  // Bulk delete: POST /api/<name>/_bulk_delete { ids?: [...], where?: {status:"done"} }
  // One read + one write. Replaces N parallel DELETE calls so concurrent
  // Clear-all-style buttons can't race the JSON file.
  app.post(`/api/${name}/_bulk_delete`, async (req, res) => {
    const result = await mutateJson(file, async (items) => {
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
      return {
        items: filtered,
        result: { ok: true, deleted, remaining: filtered.length },
      };
    });
    res.json(result);
  });
}

collection("tasks", FILES.tasks, "t", normalizeTask);
collection("suggested_changes", FILES.suggested_changes, "sc");
collection("followups", FILES.followups, "fu");
collection("done_log", FILES.done_log, "dl");
collection("agents", FILES.agents, "ag");
collection("pending_drains", FILES.pending_drains, "pd");
collection("scheduled", FILES.scheduled, "sched");

// Groups open Gmail draft send/review follow-ups into one dashboard checklist.
// This only edits dashboard JSON. It never touches Gmail or any external send path.
app.post("/api/followups/send_review_checklist", async (_req, res) => {
  const result = await mutateJson(FILES.followups, async (items) => {
    const now = new Date().toISOString();
    const existingIdx = items.findIndex(
      (item) =>
        item.kind === SEND_REVIEW_CHECKLIST_KIND &&
        !item.decision &&
        !["done", "decided", "dropped"].includes(item.status)
    );
    const existing = existingIdx >= 0 ? items[existingIdx] : null;
    const candidates = items.filter(isSendReviewDraftFollowup);

    if (candidates.length === 0 && !existing) {
      return {
        skipWrite: true,
        result: {
          ok: true,
          grouped: 0,
          checklist: null,
          message: "No eligible Gmail draft follow-ups to group.",
        },
      };
    }

    const checklistId = existing?.id || nextId("fu", items);
    const byId = new Map(
      (Array.isArray(existing?.checklist_items) ? existing.checklist_items : [])
        .filter((item) => item?.followup_id || item?.id)
        .map((item) => [item.followup_id || item.id, item])
    );
    for (const candidate of candidates) {
      byId.set(candidate.id, {
        ...(byId.get(candidate.id) || {}),
        ...sendReviewChecklistItem(candidate),
      });
    }
    const checklistItems = [...byId.values()].sort(
      (a, b) =>
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
    );
    const validItemIds = new Set(checklistItems.map((item) => item.followup_id || item.id));
    const checkedItemIds = (
      Array.isArray(existing?.checked_item_ids) ? existing.checked_item_ids : []
    ).filter((id) => validItemIds.has(id));
    const checklist = {
      ...(existing || {}),
      id: checklistId,
      kind: SEND_REVIEW_CHECKLIST_KIND,
      source: "dashboard-action",
      status: "pending",
      text: sendReviewChecklistText(checklistItems.length),
      checklist_items: checklistItems,
      checked_item_ids: checkedItemIds,
      decision_options: ["Reviewed in Gmail", "Needs edits", "Hold for later"],
      grouped_count: checklistItems.length,
      updated_at: now,
      created_at: existing?.created_at || now,
    };

    if (existingIdx >= 0) {
      items[existingIdx] = checklist;
    } else {
      items.unshift(checklist);
    }

    const candidateIds = new Set(candidates.map((item) => item.id));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!candidateIds.has(item.id)) continue;
      items[i] = {
        ...item,
        status: "grouped",
        decision: `Grouped into ${checklistId} send-review checklist.`,
        send_review_grouped_into: checklistId,
        grouped_at: now,
      };
    }

    return {
      result: {
        ok: true,
        grouped: candidates.length,
        checklist,
      },
    };
  });
  res.json(result);
});

// Retry a blocked ticket: atomic blocked -> queued flip that preserves the
// blocker note and bumps the ticket to the head of the next drain. Only blocked
// tickets are eligible; any other status returns 409 so we never silently
// requeue work that's already in flight or done.
app.post("/api/tasks/:id/retry", async (req, res) => {
  const result = await mutateJson(FILES.tasks, async (items) => {
    const idx = items.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return { skipWrite: true, result: { error: "not found", code: 404 } };
    const cur = normalizeTask({ ...items[idx] });
    if (cur.status !== "blocked") {
      return {
        skipWrite: true,
        result: {
          error: `cannot retry from status=${cur.status}; only blocked -> queued allowed`,
          code: 409,
        },
      };
    }
    const retryCount = (Number(cur.retry_count) || 0) + 1;
    const now = new Date().toISOString();
    const prevNote = (cur.note || "").trim();
    const next = {
      ...cur,
      status: "queued",
      retry_count: retryCount,
      retried_at: now,
      assigned_next: true,
      // Preserve the original blocker note so we don't lose context. First retry
      // captures the note as-is; subsequent retries append so we keep a trail.
      retry_from_note: prevNote
        ? cur.retry_from_note
          ? `${cur.retry_from_note}\n---\nretry ${retryCount} (${now}): ${prevNote}`
          : prevNote
        : cur.retry_from_note || null,
      // Clear the live `note` so the next drain doesn't read it as a fresh blocker.
      note: null,
    };
    items[idx] = next;
    return { result: { ticket: next, code: 200 } };
  });
  if (result?.code && result.code !== 200) {
    return res.status(result.code).json({ error: result.error });
  }
  res.json(result.ticket);
});

// Convenience: promote a Suggested Change into a queued ticket in one call.
app.post("/api/suggested_changes/:id/promote", async (req, res) => {
  const result = await withFileLocks([FILES.suggested_changes, FILES.tasks], async () => {
    const scs = await readJson(FILES.suggested_changes);
    const idx = scs.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return null;
    const sc = scs[idx];
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
    scs[idx] = { ...scs[idx], status: "promoted", promoted_to: ticket.id };
    await writeJson(FILES.tasks, tasks);
    await writeJson(FILES.suggested_changes, scs);
    return { ticket, sc: scs[idx] };
  });
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/scheduler", async (_req, res) => {
  const pidMeta = await fileMeta(SCHEDULER_PID_FILE);
  let pid = null;
  let pidRaw = "";
  if (pidMeta.exists) {
    try {
      pidRaw = (await fs.readFile(SCHEDULER_PID_FILE, "utf8")).trim();
      const parsed = Number(pidRaw);
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
    } catch {}
  }

  const alive = processAlive(pid);
  const command = alive ? processField(pid, "command") : "";
  const processInfo = pid
    ? {
        pid,
        alive,
        status: alive ? processField(pid, "stat") : "",
        started_at_text: alive ? processField(pid, "lstart") : "",
        command,
        ...parseIntervalFromCommand(command),
      }
    : null;

  const launchAgents = await discoverLaunchAgents();
  const logPaths = new Set([
    path.join(LOGS_DIR, "scheduler.log"),
    path.join(LOGS_DIR, "scheduler.out.log"),
    path.join(LOGS_DIR, "scheduler.err.log"),
    path.join(DATA_DIR, "logs", "drain-scheduler.log"),
    path.join(DATA_DIR, "logs", "launchd-drain.out.log"),
    path.join(DATA_DIR, "logs", "launchd-drain.err.log"),
    ...launchAgents.flatMap((a) => [a.stdout_path, a.stderr_path]).filter(Boolean),
  ]);
  const logs = await Promise.all([...logPaths].map(fileMeta));
  logs.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    return new Date(b.mtime_iso || 0).getTime() - new Date(a.mtime_iso || 0).getTime();
  });

  res.json({
    generated_at: new Date().toISOString(),
    schedule_model: {
      durable: launchAgents.length > 0,
      detail:
        launchAgents.length > 0
          ? "LaunchAgent plist(s) provide durable schedule metadata. PID files are transient and can be stale between interval runs."
          : "No durable scheduler config file found. This view is inferred from local PID and log files only.",
    },
    pid_file: {
      ...pidMeta,
      pid,
      raw: pidRaw,
      status: !pidMeta.exists ? "missing" : alive ? "active" : "stale",
      process: processInfo,
    },
    launch_agents: launchAgents,
    logs,
  });
});

// Recently created handoff HTMLs. Lists the latest N files in REPORTS_DIR sorted
// by mtime desc. Each row exposes a /reports/<filename> URL the frontend can
// link to with target=_blank.
app.get("/api/recent_handoffs", async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
  try {
    const names = await fs.readdir(REPORTS_DIR);
    const htmls = names.filter((n) => n.toLowerCase().endsWith(".html"));
    const stats = await Promise.all(
      htmls.map(async (n) => {
        try {
          const st = await fs.stat(path.join(REPORTS_DIR, n));
          return { filename: n, mtime_ms: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
    );
    const rows = stats
      .filter(Boolean)
      .sort((a, b) => b.mtime_ms - a.mtime_ms)
      .slice(0, limit)
      .map((r) => ({
        filename: r.filename,
        mtime_iso: new Date(r.mtime_ms).toISOString(),
        size: r.size,
        relative_url: `/reports/${encodeURIComponent(r.filename)}`,
      }));
    res.json(rows);
  } catch (err) {
    if (err.code === "ENOENT") return res.json([]);
    console.error("[recent_handoffs]", err);
    res.status(500).json({ error: err.message });
  }
});

// Serve a local report path through localhost so dashboard links work in browsers
// that block http -> file:// navigation. Restricted to known report roots.
app.get("/api/local_report", async (req, res) => {
  try {
    const full = await resolveLocalReportFile(req.query.path);
    res.type("html");
    res.sendFile(full);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[local_report]", err);
    res.status(status).send(err.message || "local report error");
  }
});

// Serve the handoff HTML files themselves. Path-traversal guarded by basename().
app.get("/reports/:filename", async (req, res) => {
  const safe = path.basename(req.params.filename || "");
  if (!safe || !safe.toLowerCase().endsWith(".html")) {
    return res.status(400).send("bad filename");
  }
  const full = path.join(REPORTS_DIR, safe);
  try {
    await fs.access(full);
    res.sendFile(full);
  } catch {
    res.status(404).send("not found");
  }
});

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
function resolvePathBin(name) {
  try {
    const found = spawnSync("sh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const bin = found.stdout?.trim().split("\n")[0];
    if (found.status === 0 && bin) return bin;
  } catch {}
  return null;
}

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
  return resolvePathBin("claude") || "claude"; // preserve old PATH fallback
}

function resolveCodexBin() {
  const candidates = [
    process.env.CODEX_BIN,
    path.join(os.homedir(), ".local/bin/codex"),
    path.join(os.homedir(), ".nvm", "versions", "node", process.version, "bin", "codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return resolvePathBin("codex");
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

// Spawn Codex non-interactively. Codex does not use Claude's stream-json stdin
// protocol, so run the supported headless entrypoint and stream its JSONL output
// into the same drain log shape.
function spawnCodexExecSession({ codexBin, cwd, prompt, logPath }) {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C", cwd,
    prompt,
  ];
  const child = spawn(codexBin, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const logStream = createWriteStream(logPath, { flags: "a" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (err) => {
    try { logStream.write(`\n# spawn error: ${err.message}\n`); } catch {}
  });
  child.unref();
  return { child, mode: "codex-exec-json" };
}

app.post("/api/drain/run", async (req, res) => {
  const prompt = (req.body && req.body.prompt) || "/ai-slaves";
  const runtime = (req.body && req.body.runtime) || "claude";
  if (!["claude", "codex"].includes(runtime)) {
    return res.status(400).json({ ok: false, error: "runtime must be claude or codex" });
  }
  const bin = runtime === "codex" ? resolveCodexBin() : resolveClaudeBin();
  if (!bin) {
    return res.status(503).json({
      ok: false,
      error: `Cannot find ${runtime} CLI. Set ${runtime.toUpperCase()}_BIN or put ${runtime} on PATH.`,
      runtime,
    });
  }
  const cwd = (req.body && req.body.cwd) || os.homedir();
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    const startedAt = new Date().toISOString();
    const logPath = path.join(LOGS_DIR, `drain-${runtime}-${Date.now()}.log`);
    // Header up-front, then the spawn appends its stream-json output to the same file.
    await fs.writeFile(
      logPath,
      `# drain fire ${startedAt}\n# runtime: ${runtime}\n# bin: ${bin}\n# prompt: ${prompt}\n# cwd: ${cwd}\n\n`,
      "utf8"
    );
    const { child, mode } = runtime === "codex"
      ? spawnCodexExecSession({ codexBin: bin, cwd, prompt, logPath })
      : spawnClaudeStreamSession({ claudeBin: bin, cwd, prompt, logPath });

    // Mirror to pending_drains so the UI list still shows what happened.
    try {
      await mutateJson(FILES.pending_drains, async (items) => {
        const item = {
          id: nextId("pd", items),
          status: "fired",
          requested_at: startedAt,
          note: `direct fire via /api/drain/run, ${runtime}, ${mode} (PID ${child.pid})`,
          pid: child.pid,
          log_path: logPath,
          mode,
          runtime,
        };
        items.unshift(item);
        return { result: item };
      });
    } catch (e) {
      // non-fatal
    }

    res.json({
      ok: true,
      pid: child.pid,
      log_path: logPath,
      bin,
      mode,
      runtime,
      started_at: startedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, runtime });
  }
});

const PORT = process.env.PORT || 5176;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`AI Slaves Power Doc API listening on http://${HOST}:${PORT}`);
});
