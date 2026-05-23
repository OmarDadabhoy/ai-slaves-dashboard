// Route handlers for the Vercel API. Mirrors server.js's behavior but reads
// and writes against Vercel Blob instead of the local filesystem.
//
// Storage shape: per-row blobs at ai-slaves/<collection>/<id>.json. See
// store.js for the rationale. The TL;DR: concurrent POSTs against the
// same collection used to clobber each other because every mutation was
// a read-modify-write of one big blob. Per-row writes don't collide on
// distinct IDs, and createRow() uses allowOverwrite=false for atomic
// create-or-fail with retry-on-conflict on the rare same-ID race.
//
// Endpoints that depend on local machine state (spawn claude/codex, inspect
// launchd, read ~/Desktop/Ai-slaves/state/reports/) return stub responses
// instead of failing loudly. Those features only make sense in local mode.

import {
  listRows,
  readRow,
  writeRow,
  deleteRow,
  mutateRow,
  createRow,
} from "./store.js";

const STATUS_DEFAULTS = {
  tasks: "queued",
  suggested_changes: "pending",
  agents: "running",
  pending_drains: "pending",
  scheduled: "enabled",
};

const SEND_REVIEW_CHECKLIST_KIND = "gmail_send_review_checklist";

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
  let items = await listRows(name);
  if (name === "tasks") items = items.map(normalizeTask);
  res.status(200).json(items);
}

export async function handleCollectionPost(name, req, res) {
  const body = parseBody(req);
  // createRow handles the ID-collision race: if two concurrent POSTs both
  // computed the same candidate ID, exactly one wins and the loser retries
  // with the next number. Both end up persisted with distinct IDs.
  const item = await createRow(name, (id) => {
    const next = {
      id,
      created_at: new Date().toISOString(),
      ...body,
    };
    const def = STATUS_DEFAULTS[name];
    if (def && !next.status) next.status = def;
    if (name === "tasks") normalizeTask(next);
    return next;
  });
  res.status(200).json(item);
}

export async function handleCollectionPatch(name, id, req, res) {
  const body = parseBody(req);
  const item = await mutateRow(name, id, async (cur) => {
    if (!cur) return { skipWrite: true, result: null };
    const merged = { ...cur, ...body };
    if (name === "tasks") normalizeTask(merged);
    return { value: merged, result: merged };
  });
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(200).json(item);
}

export async function handleCollectionDelete(name, id, _req, res) {
  await deleteRow(name, id);
  res.status(200).json({ ok: true });
}

export async function handleBulkDelete(name, req, res) {
  const body = parseBody(req);
  const idSet = new Set(Array.isArray(body?.ids) ? body.ids : []);
  const where = body?.where && typeof body.where === "object" ? body.where : null;

  // For bulk-by-id we don't need to list everything; just delete each ID.
  // For bulk-by-where we have to list and filter.
  let toDelete;
  if (idSet.size > 0 && !where) {
    toDelete = [...idSet];
  } else {
    const items = await listRows(name);
    toDelete = items
      .filter((i) => {
        if (idSet.has(i.id)) return true;
        if (where) {
          for (const k of Object.keys(where)) {
            if (i[k] !== where[k]) return false;
          }
          return true;
        }
        return false;
      })
      .map((i) => i.id);
  }
  await Promise.all(toDelete.map((id) => deleteRow(name, id)));
  // Remaining count: skip a re-list when caller passed explicit ids only
  // (saves a roundtrip). When using a where clause, the list is already
  // in hand from above.
  let remaining;
  if (idSet.size > 0 && !where) {
    remaining = (await listRows(name)).length;
  } else {
    remaining = (await listRows(name)).length;
  }
  res.status(200).json({ ok: true, deleted: toDelete.length, remaining });
}

// ============================================================
// Specialized routes
// ============================================================

// Groups open Gmail draft send/review follow-ups into one dashboard checklist.
// Touches multiple rows in followups: creates-or-updates the checklist row,
// then patches each candidate row to mark it grouped. Per-row writes mean
// each individual write is atomic; the only risk is partial application
// if the function dies mid-way, which is no worse than the old shape.
export async function handleSendReviewChecklist(_req, res) {
  const items = await listRows("followups");
  const now = new Date().toISOString();
  const existing = items.find(
    (item) =>
      item.kind === SEND_REVIEW_CHECKLIST_KIND &&
      !item.decision &&
      !["done", "decided", "dropped"].includes(item.status)
  );
  const candidates = items.filter(isSendReviewDraftFollowup);

  if (candidates.length === 0 && !existing) {
    res.status(200).json({
      ok: true,
      grouped: 0,
      checklist: null,
      message: "No eligible Gmail draft follow-ups to group.",
    });
    return;
  }

  // Build checklist contents. We need a stable ID; if no existing checklist
  // row, mint one via createRow so the ID-collision protection applies.
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

  let checklist;
  if (existing) {
    checklist = {
      ...existing,
      kind: SEND_REVIEW_CHECKLIST_KIND,
      source: "dashboard-action",
      status: "pending",
      text: sendReviewChecklistText(checklistItems.length),
      checklist_items: checklistItems,
      checked_item_ids: checkedItemIds,
      decision_options: ["Reviewed in Gmail", "Needs edits", "Hold for later"],
      grouped_count: checklistItems.length,
      updated_at: now,
      created_at: existing.created_at || now,
    };
    await writeRow("followups", checklist.id, checklist);
  } else {
    checklist = await createRow("followups", (id) => ({
      id,
      kind: SEND_REVIEW_CHECKLIST_KIND,
      source: "dashboard-action",
      status: "pending",
      text: sendReviewChecklistText(checklistItems.length),
      checklist_items: checklistItems,
      checked_item_ids: checkedItemIds,
      decision_options: ["Reviewed in Gmail", "Needs edits", "Hold for later"],
      grouped_count: checklistItems.length,
      updated_at: now,
      created_at: now,
    }));
  }

  // Mark each candidate row as grouped. Parallel writes; each row's PUT is
  // independent so they can't collide.
  await Promise.all(
    candidates.map((cand) =>
      writeRow("followups", cand.id, {
        ...cand,
        status: "grouped",
        decision: `Grouped into ${checklist.id} send-review checklist.`,
        send_review_grouped_into: checklist.id,
        grouped_at: now,
      })
    )
  );

  res.status(200).json({
    ok: true,
    grouped: candidates.length,
    checklist,
  });
}

export async function handleTaskRetry(id, _req, res) {
  const result = await mutateRow("tasks", id, async (cur) => {
    if (!cur) return { skipWrite: true, result: { error: "not found", code: 404 } };
    const normalized = normalizeTask({ ...cur });
    if (normalized.status !== "blocked") {
      return {
        skipWrite: true,
        result: {
          error: `cannot retry from status=${normalized.status}; only blocked -> queued allowed`,
          code: 409,
        },
      };
    }
    const retryCount = (Number(normalized.retry_count) || 0) + 1;
    const now = new Date().toISOString();
    const prevNote = (normalized.note || "").trim();
    const next = {
      ...normalized,
      status: "queued",
      retry_count: retryCount,
      retried_at: now,
      assigned_next: true,
      retry_from_note: prevNote
        ? normalized.retry_from_note
          ? `${normalized.retry_from_note}\n---\nretry ${retryCount} (${now}): ${prevNote}`
          : prevNote
        : normalized.retry_from_note || null,
      note: null,
    };
    return { value: next, result: { ticket: next, code: 200 } };
  });
  if (result?.code && result.code !== 200) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(200).json(result.ticket);
}

export async function handlePromoteSc(id, _req, res) {
  const sc = await readRow("suggested_changes", id);
  if (!sc) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // Create the ticket via createRow so we get atomic ID assignment.
  const ticket = await createRow("tasks", (newId) => ({
    id: newId,
    created_at: new Date().toISOString(),
    text: sc.text || sc.title || "(no text)",
    status: "queued",
    cycle: sc.cycle,
    promoted_from: sc.id,
  }));
  // Mark the SC promoted. Single-row PATCH equivalent.
  const updatedSc = { ...sc, status: "promoted", promoted_to: ticket.id };
  await writeRow("suggested_changes", sc.id, updatedSc);
  res.status(200).json({ ticket, sc: updatedSc });
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
  await createRow("pending_drains", (id) => ({
    id,
    status: "pending",
    requested_at: new Date().toISOString(),
    note,
    runtime,
    source: "vercel-dashboard",
  }));
  res.status(503).json({
    ok: false,
    error:
      "Cloud mode cannot spawn drains. The request was queued; run /ai-slaves locally to pick it up.",
    runtime,
    queued: true,
  });
}
