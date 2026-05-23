// Route handlers for the Vercel API. Mirrors server.js's behavior but reads
// and writes against Vercel Blob instead of the local filesystem.
//
// Endpoints that depend on local machine state (spawn claude/codex, inspect
// launchd, read ~/Desktop/Ai-slaves/state/reports/) return stub responses
// instead of failing loudly. Those features only make sense in local mode.

import { readCollection, mutateCollection, writeCollection } from "./store.js";

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

const STATUS_DEFAULTS = {
  tasks: "queued",
  suggested_changes: "pending",
  agents: "running",
  pending_drains: "pending",
  scheduled: "enabled",
};

const SEND_REVIEW_CHECKLIST_KIND = "gmail_send_review_checklist";

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

function normalizeTask(t) {
  if (!t) return t;
  if (t.status === "todo") t.status = "queued";
  if (!t.text && t.title) t.text = t.title;
  return t;
}

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

// Parses `req.body` defensively. Vercel Node functions sometimes deliver the
// body as a string when content-type isn't set; tolerate both shapes.
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

// ============================================================
// Collection CRUD (tasks, suggested_changes, followups, done_log,
// agents, pending_drains, scheduled)
// ============================================================

export async function handleCollectionGet(name, _req, res) {
  let items = await readCollection(name);
  if (name === "tasks") items = items.map(normalizeTask);
  res.status(200).json(items);
}

export async function handleCollectionPost(name, req, res) {
  const body = parseBody(req);
  const prefix = ID_PREFIXES[name];
  const item = await mutateCollection(name, async (items) => {
    const next = {
      id: nextId(prefix, items),
      created_at: new Date().toISOString(),
      ...body,
    };
    const def = STATUS_DEFAULTS[name];
    if (def && !next.status) next.status = def;
    if (name === "tasks") normalizeTask(next);
    items.unshift(next);
    return { result: next, items };
  });
  res.status(200).json(item);
}

export async function handleCollectionPatch(name, id, req, res) {
  const body = parseBody(req);
  const item = await mutateCollection(name, async (items) => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return { skipWrite: true, result: null };
    items[idx] = { ...items[idx], ...body };
    if (name === "tasks") normalizeTask(items[idx]);
    return { result: items[idx], items };
  });
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(item);
}

export async function handleCollectionDelete(name, id, _req, res) {
  await mutateCollection(name, async (items) => ({
    items: items.filter((i) => i.id !== id),
    result: { ok: true },
  }));
  res.status(200).json({ ok: true });
}

export async function handleBulkDelete(name, req, res) {
  const body = parseBody(req);
  const result = await mutateCollection(name, async (items) => {
    const idSet = new Set(Array.isArray(body?.ids) ? body.ids : []);
    const where = body?.where && typeof body.where === "object" ? body.where : null;
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
  res.status(200).json(result);
}

// ============================================================
// Specialized routes
// ============================================================

export async function handleSendReviewChecklist(_req, res) {
  const result = await mutateCollection("followups", async (items) => {
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
      items,
    };
  });
  res.status(200).json(result);
}

export async function handleTaskRetry(id, _req, res) {
  const result = await mutateCollection("tasks", async (items) => {
    const idx = items.findIndex((i) => i.id === id);
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
      retry_from_note: prevNote
        ? cur.retry_from_note
          ? `${cur.retry_from_note}\n---\nretry ${retryCount} (${now}): ${prevNote}`
          : prevNote
        : cur.retry_from_note || null,
      note: null,
    };
    items[idx] = next;
    return { result: { ticket: next, code: 200 }, items };
  });
  if (result?.code && result.code !== 200) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(200).json(result.ticket);
}

export async function handlePromoteSc(id, _req, res) {
  const scs = await readCollection("suggested_changes");
  const idx = scs.findIndex((s) => s.id === id);
  if (idx === -1) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const sc = scs[idx];
  const tasks = await readCollection("tasks");
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
  await writeCollection("tasks", tasks);
  await writeCollection("suggested_changes", scs);
  res.status(200).json({ ticket, sc: scs[idx] });
}

// ============================================================
// Cloud-mode stubs for endpoints that depend on local machine state
// ============================================================

export function handleHealth(_req, res) {
  res.status(200).json({ ok: true, mode: "vercel" });
}

export function handleScheduler(_req, res) {
  // No launchd / no PID file on Vercel. Return a stub so the UI doesn't break.
  res.status(200).json({
    generated_at: new Date().toISOString(),
    schedule_model: {
      durable: false,
      detail:
        "Scheduler details only available in local mode (server.js). The Vercel deploy is read/write for collections but does not spawn drains or inspect launchd.",
    },
    pid_file: { exists: false, status: "missing", pid: null },
    launch_agents: [],
    logs: [],
  });
}

export async function handleRecentHandoffs(_req, res) {
  // No local reports filesystem on Vercel. Empty array so the panel collapses cleanly.
  res.status(200).json([]);
}

export function handleLocalReport(_req, res) {
  res.status(404).send("local reports are not available in cloud mode");
}

export function handleReportsFile(_req, res) {
  res.status(404).send("local reports are not available in cloud mode");
}

export async function handleDrainRun(req, res) {
  // Cloud mode can't spawn local processes. Instead, queue the request into
  // pending_drains so when Omar next runs /ai-slaves locally the drain picks
  // it up. This matches server.js's fallback behavior when /api/drain/run 500s.
  const body = parseBody(req);
  const runtime = body?.runtime || "claude";
  const note = `cloud-mode ${runtime} request from dashboard at ${new Date().toISOString()}; run /ai-slaves locally to pick up`;
  await mutateCollection("pending_drains", async (items) => {
    items.unshift({
      id: nextId("pd", items),
      status: "pending",
      requested_at: new Date().toISOString(),
      note,
      runtime,
      source: "vercel-dashboard",
    });
    return { items, result: null };
  });
  res.status(503).json({
    ok: false,
    error:
      "Cloud mode cannot spawn drains. The request was queued; run /ai-slaves locally to pick it up.",
    runtime,
    queued: true,
  });
}
