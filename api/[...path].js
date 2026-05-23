// Catch-all Vercel serverless function. Routes /api/* paths to handlers
// in _lib/routes.js. Same shape as server.js but reads/writes from Vercel
// Blob instead of the local filesystem.
//
// Auth: every request must include x-dashboard-token matching the
// DASHBOARD_TOKEN env var. See _lib/auth.js.

import { checkToken } from "./_lib/auth.js";
import {
  handleCollectionGet,
  handleCollectionPost,
  handleCollectionPatch,
  handleCollectionDelete,
  handleBulkDelete,
  handleSendReviewChecklist,
  handleTaskRetry,
  handlePromoteSc,
  handleHealth,
  handleScheduler,
  handleRecentHandoffs,
  handleLocalReport,
  handleReportsFile,
  handleDrainRun,
} from "./_lib/routes.js";

const COLLECTIONS = new Set([
  "tasks",
  "suggested_changes",
  "followups",
  "done_log",
  "agents",
  "pending_drains",
  "scheduled",
]);

function parseSegments(query) {
  const raw = query.path;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    // Vercel sometimes nests segments inside a single string element when the
    // rewrite collapses them. Normalize by splitting on `/`.
    return raw.flatMap((s) => String(s).split("/")).filter(Boolean);
  }
  return String(raw).split("/").filter(Boolean);
}

export default async function handler(req, res) {
  // CORS: allow same-origin and the production domain. Vite dev proxies to
  // server.js so this only fires on Vercel; same-origin is the default.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Dashboard-Token, x-dashboard-token"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // Auth gate. /api/health stays open so the frontend can probe.
  const segments = parseSegments(req.query);
  const path = segments.join("/");
  const isHealth = segments.length === 1 && segments[0] === "health";
  if (!isHealth && !checkToken(req, res)) return;

  try {
    // /api/health
    if (isHealth) {
      handleHealth(req, res);
      return;
    }

    // /api/scheduler
    if (segments.length === 1 && segments[0] === "scheduler") {
      handleScheduler(req, res);
      return;
    }

    // /api/recent_handoffs
    if (segments.length === 1 && segments[0] === "recent_handoffs") {
      await handleRecentHandoffs(req, res);
      return;
    }

    // /api/local_report
    if (segments.length === 1 && segments[0] === "local_report") {
      handleLocalReport(req, res);
      return;
    }

    // /api/drain/run
    if (segments.length === 2 && segments[0] === "drain" && segments[1] === "run") {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }
      await handleDrainRun(req, res);
      return;
    }

    // /api/followups/send_review_checklist
    if (
      segments.length === 2 &&
      segments[0] === "followups" &&
      segments[1] === "send_review_checklist"
    ) {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }
      await handleSendReviewChecklist(req, res);
      return;
    }

    // /api/tasks/:id/retry
    if (
      segments.length === 3 &&
      segments[0] === "tasks" &&
      segments[2] === "retry"
    ) {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }
      await handleTaskRetry(segments[1], req, res);
      return;
    }

    // /api/suggested_changes/:id/promote
    if (
      segments.length === 3 &&
      segments[0] === "suggested_changes" &&
      segments[2] === "promote"
    ) {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }
      await handlePromoteSc(segments[1], req, res);
      return;
    }

    // /api/<collection>/_bulk_delete
    if (
      segments.length === 2 &&
      COLLECTIONS.has(segments[0]) &&
      segments[1] === "_bulk_delete"
    ) {
      if (req.method !== "POST") {
        res.status(405).json({ error: "method not allowed" });
        return;
      }
      await handleBulkDelete(segments[0], req, res);
      return;
    }

    // /api/<collection>
    if (segments.length === 1 && COLLECTIONS.has(segments[0])) {
      const name = segments[0];
      if (req.method === "GET") {
        await handleCollectionGet(name, req, res);
        return;
      }
      if (req.method === "POST") {
        await handleCollectionPost(name, req, res);
        return;
      }
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    // /api/<collection>/:id
    if (segments.length === 2 && COLLECTIONS.has(segments[0])) {
      const name = segments[0];
      const id = segments[1];
      if (req.method === "PATCH") {
        await handleCollectionPatch(name, id, req, res);
        return;
      }
      if (req.method === "DELETE") {
        await handleCollectionDelete(name, id, req, res);
        return;
      }
      if (req.method === "GET") {
        // Convenience: not in server.js, but useful for cloud debugging.
        const { readRow } = await import("./_lib/store.js");
        const found = await readRow(name, id);
        if (!found) {
          res.status(404).json({ error: "not found" });
          return;
        }
        res.status(200).json(found);
        return;
      }
      res.status(405).json({ error: "method not allowed" });
      return;
    }

    // /reports/<filename> - cloud stub (Vercel can't serve local files)
    if (segments[0] === "reports") {
      handleReportsFile(req, res);
      return;
    }

    res.status(404).json({ error: "not found", path });
  } catch (err) {
    console.error("[api] uncaught error", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
