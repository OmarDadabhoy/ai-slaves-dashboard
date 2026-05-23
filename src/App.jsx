import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";

const API = "/api";

// Vercel deployment uses a shared-secret token gate. Local dev has no gate
// (server.js doesn't enforce it). The token is stored in localStorage and
// sent as an `x-dashboard-token` header on every API call.
const TOKEN_STORAGE_KEY = "ai_slaves_dashboard_token";
function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
function setStoredToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_STORAGE_KEY, t);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}

// Cheap mobile detector. The CSS handles >99% of the responsive work, but we
// use this to default-collapse heavy panels (SC, Follow-up, Recently Done) on
// mobile so the page is scannable without scroll-spamming.
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

// Wraps fetch with the dashboard token header. Use everywhere instead of fetch.
async function apiFetch(token, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (token) headers.set("x-dashboard-token", token);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API}${path}`, { ...init, headers });
}

const TICKET_STATUSES = ["queued", "in_progress", "blocked", "done"];
const SEND_REVIEW_CHECKLIST_KIND = "gmail_send_review_checklist";

// Campaign color palette. Deterministic by hashing the campaign string.
// Mixes existing accent colors with 3 added muted tones (steel, gold, plum).
const CAMPAIGN_COLORS = [
  { name: "accent",  border: "#7c9cff", soft: "rgba(124, 156, 255, 0.18)", text: "#7c9cff" },
  { name: "green",   border: "#5fce85", soft: "rgba(95, 206, 133, 0.18)",  text: "#5fce85" },
  { name: "amber",   border: "#f5b86b", soft: "rgba(245, 184, 107, 0.18)", text: "#f5b86b" },
  { name: "purple",  border: "#b18cf2", soft: "rgba(177, 140, 242, 0.18)", text: "#b18cf2" },
  { name: "steel",   border: "#6ec6c2", soft: "rgba(110, 198, 194, 0.18)", text: "#6ec6c2" },
  { name: "gold",    border: "#d4b14a", soft: "rgba(212, 177, 74, 0.20)",  text: "#d4b14a" },
  { name: "plum",    border: "#c47bae", soft: "rgba(196, 123, 174, 0.18)", text: "#c47bae" },
];

function hashString(s) {
  // Simple djb2 hash. Stable across renders + browsers.
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return Math.abs(h);
}

function campaignColor(campaign) {
  if (!campaign) return null;
  const idx = hashString(String(campaign)) % CAMPAIGN_COLORS.length;
  return CAMPAIGN_COLORS[idx];
}

// "campaign:9b1a165c rest of the task text" -> { campaign: "9b1a165c", text: "rest of the task text" }
// Falls back to plain text if no prefix.
function parseCampaignPrefix(raw) {
  const trimmed = (raw || "").trim();
  const m = trimmed.match(/^campaign:(\S+)\s+(.+)$/i);
  if (!m) return { campaign: null, text: trimmed };
  return { campaign: m[1], text: m[2].trim() };
}

function statusLabel(s) {
  return (
    {
      queued: "Queued",
      todo: "Queued",
      in_progress: "In progress",
      blocked: "Blocked",
      done: "Done",
      pending: "Pending",
      promoted: "Promoted",
      dropped: "Dropped",
      running: "Running",
      completed: "Completed",
      fired: "Fired",
      active: "Active",
      stale: "Stale",
      missing: "Missing",
      loaded: "Loaded",
      enabled: "Enabled",
      disabled: "Disabled",
      "in-session": "In session",
      grouped: "Grouped",
    }[s] || s
  );
}

function normalizeStatus(s) {
  return s === "todo" ? "queued" : s;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Compact "5m ago / 2h ago / 3d ago" relative time. Falls back to fmtDate for >7d.
function fmtRelative(iso) {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return "just now";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day <= 7) return `${day}d ago`;
    return fmtDate(iso);
  } catch {
    return "";
  }
}

function fmtInterval(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

function fileName(file) {
  if (!file) return "";
  return String(file).split(/[\\/]/).pop();
}

function reportHref(report) {
  const value = String(report || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("/reports/")) return value;
  return `${API}/local_report?path=${encodeURIComponent(value)}`;
}

function extractLocalReportLink(...values) {
  for (const raw of values) {
    const text = String(raw || "");
    const fileUrl = text.match(/file:\/\/[^\s<>"')]+?\.html\b/i);
    if (fileUrl) return fileUrl[0];

    const localPath = text.match(/(?:^|[\s([<])((?:~?\/|state\/reports\/)[^\s<>"')]+?\.html\b)/i);
    if (localPath) return localPath[1];
  }
  return null;
}

function followupText(item) {
  return String(item?.text || item?.question || item?.title || "").trim();
}

function isSendReviewDraftFollowup(item) {
  if (!item || item.kind === SEND_REVIEW_CHECKLIST_KIND) return false;
  if (item.decision || item.send_review_grouped_into) return false;
  if (["done", "decided", "dropped", "grouped"].includes(item.status)) return false;

  const lower = followupText(item).toLowerCase();
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

// Strip the leading timestamp + trailing "-done.html" / "-needs_human.html" so the
// filename reads like a sentence in the recent-HTMLs list.
function prettyHandoffName(filename) {
  if (!filename) return "(no name)";
  let s = filename.replace(/\.html$/i, "");
  // Leading "20260516T143302Z-" or "20260516T143302Z_"
  s = s.replace(/^\d{8}T\d{6}Z[-_]/, "");
  // Trailing status suffix
  s = s.replace(/[-_](done|needs_human|blocked|partial)$/i, "");
  return s.replace(/[-_]+/g, " ").trim() || filename;
}

// Tokenize a string into 4+ char lowercase words, skipping noise/stopwords.
const FU_STOPWORDS = new Set([
  "this","that","with","from","into","over","when","then","they","them","their",
  "have","has","had","were","been","being","still","need","needs","know","like",
  "next","week","weeks","month","months","year","years","time","also","more",
  "less","most","than","what","which","where","while","there","here","just","only",
  "should","could","would","will","wont","cant","didnt","doesnt","isnt","arent",
  "before","after","during","without","within","still","again","done","todo",
  "make","made","each","some","every","both","much","many","very","really",
  "about","through","cycle","decide","decision","review","check","confirm",
  "pending","status","note","plan","plans","task","tasks","ticket","tickets",
]);
function tokenize(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !FU_STOPWORDS.has(w));
}

// Find the best handoff URL for a followup. Strategy (b):
//   1) Prefer done_log entries in the SAME cycle whose title shares >=2 tokens
//      with the followup text. Break ties by token-overlap count, then recency.
//   2) Fall back to ANY cycle if no same-cycle match.
// Returns the handoff path/url string, or null. Pure function: safe in useMemo.
function findMatchingHandoff(fu, doneLog) {
  if (!fu || !doneLog || doneLog.length === 0) return null;
  const fuText = fu.text || fu.question || fu.title || "";
  const fuTokens = new Set(tokenize(fuText));
  if (fuTokens.size === 0) return null;
  const candidates = [];
  for (const d of doneLog) {
    const handoff = d.handoff_path || d.handoff;
    if (!handoff) continue;
    const title = d.title || d.text || "";
    let overlap = 0;
    for (const w of tokenize(title)) if (fuTokens.has(w)) overlap++;
    if (overlap < 2) continue;
    const sameCycle = fu.cycle != null && d.cycle === fu.cycle;
    candidates.push({ handoff, overlap, sameCycle, created_at: d.created_at });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.sameCycle !== b.sameCycle) return a.sameCycle ? -1 : 1;
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
  return candidates[0].handoff;
}

// Section wraps a titled panel. `collapsible` enables the mobile accordion
// toggle: passes through an internal collapsed state controlled by a button
// next to the title. On desktop, sections always render expanded.
function Section({ title, count, action, children, collapsible = false, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <section className={`section ${collapsed ? "section--collapsed" : ""}`}>
      <div className="section-header">
        <div className="section-title">
          <span>{title}</span>
          {typeof count === "number" && <span className="count">{count}</span>}
          {collapsible && (
            <button
              className="section-toggle"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand section" : "Collapse section"}
            >
              {collapsed ? "show" : "hide"}
            </button>
          )}
        </div>
        {action}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

function TicketCard({ ticket, onMove, onDelete, onAssignNext, onRetry }) {
  const status = normalizeStatus(ticket.status);
  const body = ticket.text || ticket.title || "(untitled)";
  const color = campaignColor(ticket.campaign);
  const handoff = ticket.handoff_path || ticket.handoff;
  const localReport = extractLocalReportLink(body, ticket.note);
  const handoffHref = handoff ? reportHref(handoff) : "";
  const localReportHref = localReport ? reportHref(localReport) : "";
  // If a campaign color is set, override the left border + tint the row.
  const style = color
    ? { borderLeftColor: color.border, background: color.soft }
    : undefined;
  return (
    <div className={`ticket ticket--${status}`} style={style}>
      <div className="ticket-head">
        <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
        <span className="ticket-id">{ticket.id}</span>
      </div>
      <div className="ticket-body">{body}</div>
      <div className="ticket-meta">
        {ticket.campaign && (
          <span
            className="chip chip--campaign"
            style={{
              color: color?.text,
              borderColor: color?.border,
              background: color?.soft,
            }}
            title="campaign tag"
          >
            {ticket.campaign}
          </span>
        )}
        {ticket.cycle != null && <span className="chip">cycle {ticket.cycle}</span>}
        {ticket.created_at && <span className="chip">{fmtDate(ticket.created_at)}</span>}
        {ticket.source && <span className="chip">{ticket.source}</span>}
        {ticket.assigned_next && <span className="chip chip--accent">next drain</span>}
        {handoff && (
          <a
            className="chip chip--link"
            href={handoffHref}
            target="_blank"
            rel="noreferrer"
            title={handoff}
          >
            handoff
          </a>
        )}
        {localReportHref && localReportHref !== handoffHref && (
          <a
            className="chip chip--link"
            href={localReportHref}
            target="_blank"
            rel="noreferrer"
            title={localReport}
          >
            report
          </a>
        )}
      </div>
      <div className="ticket-actions">
        <select
          className="status-select"
          value={status}
          onChange={(e) => onMove(ticket.id, e.target.value)}
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        {status === "blocked" && onRetry && (
          <button
            className="btn btn-success btn-xs"
            onClick={() => onRetry(ticket.id)}
            title="Requeue this ticket with its original note and bump to head of next drain"
          >
            {ticket.retry_count ? `retry (${ticket.retry_count})` : "retry"}
          </button>
        )}
        <button
          className={`btn btn-ghost btn-xs ${ticket.assigned_next ? "is-on" : ""}`}
          onClick={() => onAssignNext(ticket.id, !ticket.assigned_next)}
          title="Flag for next drain to pick up"
        >
          {ticket.assigned_next ? "queued for drain" : "assign next drain"}
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => onDelete(ticket.id)}
          title="Delete ticket"
        >
          delete
        </button>
      </div>
    </div>
  );
}

function Lane({ status, tickets, onMove, onDelete, onAssignNext, onRetry, headAction, collapsed = false }) {
  const isCollapsed = collapsed && tickets.length > 0;
  return (
    <div className="lane">
      <div className="lane-head">
        <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
        <div className="lane-head-right">
          <span className="lane-count">{tickets.length}</span>
          {headAction}
        </div>
      </div>
      <div className={`lane-body ${isCollapsed ? "lane-body--collapsed" : ""}`}>
        {isCollapsed ? (
          <div className="lane-empty">minimized, {tickets.length} hidden</div>
        ) : tickets.length === 0 ? (
          <div className="lane-empty">empty</div>
        ) : (
          tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              onMove={onMove}
              onDelete={onDelete}
              onAssignNext={onAssignNext}
              onRetry={onRetry}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Token gate component shown when no DASHBOARD_TOKEN is in localStorage and
// the API is enforcing auth (Vercel mode). Local dev never sees this.
function TokenGate({ onAuthed }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setErr("");
    try {
      // Probe a cheap endpoint with the candidate token. /api/health is open
      // on local, gated on Vercel. We hit /api/tasks which is gated in both
      // modes when auth is enabled.
      const r = await fetch(`${API}/tasks`, {
        headers: { "x-dashboard-token": t },
      });
      if (r.status === 401 || r.status === 403) {
        setErr("Token rejected. Check your DASHBOARD_TOKEN in Vercel env vars.");
        setBusy(false);
        return;
      }
      if (!r.ok) {
        setErr(`Unexpected status ${r.status}. Trying anyway.`);
      }
      setStoredToken(t);
      onAuthed(t);
    } catch (e2) {
      setErr(`Network error: ${e2.message || e2}`);
      setBusy(false);
    }
  };
  return (
    <div className="token-gate">
      <form className="token-gate-card" onSubmit={submit}>
        <div className="token-gate-title">AI Slaves Dashboard</div>
        <div className="token-gate-sub">
          Enter your dashboard token to continue. This is the value of the
          DASHBOARD_TOKEN env var set in Vercel.
        </div>
        <input
          type="password"
          className="token-gate-input"
          placeholder="Paste token..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {err && <div className="token-gate-error">{err}</div>}
        <button
          className="btn token-gate-btn"
          type="submit"
          disabled={busy || !value.trim()}
        >
          {busy ? "Checking..." : "Unlock"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(getStoredToken());
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const isMobile = useIsMobile(768);

  // On mount, probe /api/tasks once. If 401/403, auth is required. If the
  // server returns 200 with no token, local mode is fine. This avoids forcing
  // the gate in local dev where server.js does not check tokens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/tasks`, {
          headers: token ? { "x-dashboard-token": token } : {},
        });
        if (cancelled) return;
        if (r.status === 401 || r.status === 403) {
          setAuthRequired(true);
        } else {
          setAuthRequired(false);
        }
      } catch {
        // network error: treat as local-mode, no auth required
        setAuthRequired(false);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (authChecked && authRequired && !token) {
    return (
      <TokenGate
        onAuthed={(t) => {
          setToken(t);
          setAuthRequired(false);
        }}
      />
    );
  }
  if (!authChecked) {
    return (
      <div className="token-gate">
        <div className="token-gate-card">
          <div className="token-gate-sub">Connecting...</div>
        </div>
      </div>
    );
  }
  return <DashboardApp token={token} isMobile={isMobile} onSignOut={() => { setStoredToken(""); setToken(""); setAuthRequired(true); }} />;
}

// Tiny write-through cache so the dashboard stays visible across refreshes
// and network blips. On mount we hydrate from the last-known snapshot
// (instant first paint, no blank), then loadAll fetches fresh data in
// the background and overwrites. Every state setter also persists, so
// reloads never see an empty UI.
const STATE_CACHE_KEY_PREFIX = "ai-slaves:state:v1:";
function cacheLoad(key, fallback) {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(STATE_CACHE_KEY_PREFIX + key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}
function cacheSave(key, val) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STATE_CACHE_KEY_PREFIX + key, JSON.stringify(val));
  } catch {} // quota / disabled / etc
}

function DashboardApp({ token, isMobile, onSignOut }) {
  const [tasks, setTasks] = useState(() => cacheLoad("tasks", []));
  const [scs, setScs] = useState(() => cacheLoad("scs", []));
  const [fus, setFus] = useState(() => cacheLoad("fus", []));
  const [doneLog, setDoneLog] = useState(() => cacheLoad("doneLog", []));
  const [agents, setAgents] = useState(() => cacheLoad("agents", []));
  const [pendingDrains, setPendingDrains] = useState(() => cacheLoad("pendingDrains", []));
  const [recentHandoffs, setRecentHandoffs] = useState(() => cacheLoad("recentHandoffs", []));
  const [schedulerInfo, setSchedulerInfo] = useState(() => cacheLoad("schedulerInfo", null));
  const [scheduled, setScheduled] = useState(() => cacheLoad("scheduled", []));

  // Persist every state change to localStorage so refresh / network blip
  // never blanks the dashboard. Hydration above gives instant first paint
  // from the last-known snapshot; these effects keep it current after that.
  useEffect(() => { cacheSave("tasks", tasks); }, [tasks]);
  useEffect(() => { cacheSave("scs", scs); }, [scs]);
  useEffect(() => { cacheSave("fus", fus); }, [fus]);
  useEffect(() => { cacheSave("doneLog", doneLog); }, [doneLog]);
  useEffect(() => { cacheSave("agents", agents); }, [agents]);
  useEffect(() => { cacheSave("pendingDrains", pendingDrains); }, [pendingDrains]);
  useEffect(() => { cacheSave("recentHandoffs", recentHandoffs); }, [recentHandoffs]);
  useEffect(() => { cacheSave("schedulerInfo", schedulerInfo); }, [schedulerInfo]);
  useEffect(() => { cacheSave("scheduled", scheduled); }, [scheduled]);
  const [newTask, setNewTask] = useState("");
  const [apiOnline, setApiOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  // Generation counter: every loadAll bumps it. If results come back stale
  // (a newer loadAll has been issued since), drop them. Prevents an older
  // in-flight refresh from overwriting fresh state after a mutation, which
  // was causing ticket disappear/reappear flicker.
  const loadAllGen = useRef(0);
  const [filter, setFilter] = useState("all"); // all | mine | next-drain
  const [sortBy, setSortBy] = useState("created"); // created | cycle | status
  const [view, setView] = useState("board"); // board | list
  const [drainQueuedAt, setDrainQueuedAt] = useState(null);
  const [drainFire, setDrainFire] = useState(null); // { mode: 'fired'|'queued', runtime, pid?, ts }
  const [drainFiring, setDrainFiring] = useState(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [clearMsg, setClearMsg] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [doneMinimized, setDoneMinimized] = useState(false);
  const [sendReviewBuilding, setSendReviewBuilding] = useState(false);
  const [sendReviewMsg, setSendReviewMsg] = useState(null);
  // t-647: per-SC inline expander toggle (set of expanded sc ids)
  const [expandedScIds, setExpandedScIds] = useState(() => new Set());
  // t-647: per-SC transient confirmation after "Write spec" enqueues a ticket
  const [scActionFlash, setScActionFlash] = useState({}); // { [sc.id]: { text, ticketId, ts } }
  // t-667: Retry-all-blocked bulk action progress + toast
  const [retryAllProgress, setRetryAllProgress] = useState(null); // { done, total } | null
  const [retryAllMsg, setRetryAllMsg] = useState(null);

  const ticketInputRef = useRef(null);

  const autoResizeTextarea = () => {
    const el = ticketInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    autoResizeTextarea();
  }, [newTask]);

  const loadAll = useCallback(async () => {
    const gen = ++loadAllGen.current;
    setLoading(true);
    // Use allSettled so a single fetch failure (network blip, CDN flake)
    // does NOT wipe the entire UI to empty arrays. Per-endpoint guard:
    // we only update state when that specific endpoint returned ok + data.
    // Previous state is preserved on failure so the dashboard stays visible.
    const results = await Promise.allSettled([
      apiFetch(token, "/tasks"),
      apiFetch(token, "/suggested_changes"),
      apiFetch(token, "/followups"),
      apiFetch(token, "/done_log"),
      apiFetch(token, "/agents"),
      apiFetch(token, "/pending_drains"),
      apiFetch(token, "/recent_handoffs?limit=10"),
      apiFetch(token, "/scheduler"),
      apiFetch(token, "/scheduled"),
    ]);
    // Drop stale results: if a newer loadAll has been issued, our data
    // is older than what's already onscreen. Applying it would revert
    // the UI (= the disappear/reappear flicker users were seeing).
    if (gen !== loadAllGen.current) return;
    const [tRes, sRes, fRes, dRes, aRes, pdRes, rhRes, schedRes, schdRes] = results;
    const okOrNull = async (settled) => {
      if (settled.status !== "fulfilled") return null;
      const r = settled.value;
      if (!r || !r.ok) return null;
      try { return await r.json(); } catch { return null; }
    };
    const tJ = await okOrNull(tRes);
    if (tJ !== null) {
      // Preserve any in-flight optimistic rows (added by addTicket before
      // the POST has resolved). Without this, a background loadAll firing
      // during the optimistic window wipes the row, then the POST swap
      // can't find the temp id and the ticket disappears for one cycle.
      setTasks((cur) => {
        const serverIds = new Set(tJ.map((t) => t.id));
        const pending = cur.filter((t) => t._optimistic && !serverIds.has(t.id));
        return pending.length ? [...pending, ...tJ] : tJ;
      });
    }
    const sJ = await okOrNull(sRes);
    if (sJ !== null) setScs(sJ);
    const fJ = await okOrNull(fRes);
    if (fJ !== null) setFus(fJ);
    const dJ = await okOrNull(dRes);
    if (dJ !== null) setDoneLog(dJ);
    const aJ = await okOrNull(aRes);
    if (aJ !== null) setAgents(aJ);
    const pdJ = await okOrNull(pdRes);
    if (pdJ !== null) setPendingDrains(pdJ);
    const rhJ = await okOrNull(rhRes);
    if (rhJ !== null) setRecentHandoffs(rhJ);
    const schedJ = await okOrNull(schedRes);
    if (schedJ !== null) setSchedulerInfo(schedJ);
    const schdJ = await okOrNull(schdRes);
    if (schdJ !== null) setScheduled(schdJ);

    // Health: api is online if at least one of the core endpoints (tasks)
    // resolved. Otherwise show read-only banner BUT keep existing state.
    const anyOk = [tRes, sRes, fRes, dRes, aRes].some(
      (r) => r.status === "fulfilled" && r.value && r.value.ok
    );
    if (anyOk) {
      setApiOnline(true);
    } else {
      setApiOnline(false);
      // Only fall back to local /data/*.json on local dev (server.js serves
      // them). On Vercel those paths 404 and reading would wipe state to [].
      // Detect by hostname: only attempt fallback if not on *.vercel.app.
      const isLocal = typeof window !== "undefined" &&
        !/\.vercel\.app$/i.test(window.location.hostname);
      if (isLocal) {
        try {
          const fb = await Promise.allSettled([
            fetch("/data/tasks.json"),
            fetch("/data/suggested_changes.json"),
            fetch("/data/followups.json"),
            fetch("/data/done_log.json"),
            fetch("/data/agents.json"),
            fetch("/data/pending_drains.json"),
            fetch("/data/scheduled.json"),
          ]);
          const fbJson = async (s) => {
            if (s.status !== "fulfilled" || !s.value.ok) return null;
            try { return await s.value.json(); } catch { return null; }
          };
          const [t, s, f, d, a, pd, sch] = await Promise.all(fb.map(fbJson));
          if (gen !== loadAllGen.current) return;
          if (t !== null) setTasks(t);
          if (s !== null) setScs(s);
          if (f !== null) setFus(f);
          if (d !== null) setDoneLog(d);
          if (a !== null) setAgents(a);
          if (pd !== null) setPendingDrains(pd);
          if (sch !== null) setScheduled(sch);
        } catch {}
      }
    }
    if (gen === loadAllGen.current) setLoading(false);
  }, [token]);

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 5000); // soft refresh so orchestrator writes appear live
    return () => clearInterval(id);
  }, [loadAll]);

  async function patch(path, body) {
    if (!apiOnline) return;
    const res = await apiFetch(token, path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (res.ok) loadAll();
  }

  async function post(path, body) {
    if (!apiOnline) return null;
    const res = await apiFetch(token, path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.ok) {
      loadAll();
      return res.json();
    }
    return null;
  }

  async function del(path) {
    if (!apiOnline) return;
    const res = await apiFetch(token, path, { method: "DELETE" });
    if (res.ok) loadAll();
  }

  async function addTicket() {
    const raw = newTask.trim();
    if (!raw) return;
    const { campaign, text } = parseCampaignPrefix(raw);
    if (!text) return;
    if (!apiOnline) {
      setTasks((cur) => [
        {
          id: `t-local-${Date.now()}`,
          text,
          campaign: campaign || undefined,
          status: "queued",
          created_at: new Date().toISOString(),
          source: "dashboard",
        },
        ...cur,
      ]);
      setNewTask("");
      return;
    }
    // Optimistic: show the new ticket immediately with a temporary id so the
    // user sees instant feedback. When the POST returns we swap the temp id
    // for the server-assigned one. If the POST fails we roll back.
    const tempId = `t-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      id: tempId,
      text,
      campaign: campaign || undefined,
      status: "queued",
      created_at: new Date().toISOString(),
      source: "dashboard",
      _optimistic: true,
    };
    setTasks((cur) => [optimistic, ...cur]);
    setNewTask("");
    const body = { text, source: "dashboard" };
    if (campaign) body.campaign = campaign;
    const created = await post("/tasks", body);
    setTasks((cur) => {
      if (!created || !created.id) {
        // POST failed: drop the optimistic row.
        return cur.filter((t) => t.id !== tempId);
      }
      // Replace temp row with the server's row. If a concurrent loadAll
      // already inserted the real row, drop the temp without duplicating.
      const haveReal = cur.some((t) => t.id === created.id);
      if (haveReal) return cur.filter((t) => t.id !== tempId);
      return cur.map((t) => (t.id === tempId ? { ...created } : t));
    });
  }

  function moveTicket(id, status) {
    setTasks((cur) =>
      cur.map((t) => (t.id === id ? { ...t, status } : t))
    );
    patch(`/tasks/${id}`, { status });
  }

  function setAssignNext(id, on) {
    setTasks((cur) =>
      cur.map((t) => (t.id === id ? { ...t, assigned_next: on } : t))
    );
    patch(`/tasks/${id}`, { assigned_next: on });
  }

  function deleteTicket(id) {
    setTasks((cur) => cur.filter((t) => t.id !== id));
    del(`/tasks/${id}`);
  }

  async function retryTicket(id) {
    if (!apiOnline) {
      // Local-only optimistic flip when API is offline.
      setTasks((cur) =>
        cur.map((t) =>
          t.id === id && t.status === "blocked"
            ? { ...t, status: "queued", assigned_next: true, retry_count: (t.retry_count || 0) + 1, retry_from_note: t.retry_from_note || t.note || null, note: null }
            : t
        )
      );
      return;
    }
    // Optimistic UI flip; loadAll() after the POST will reconcile with server truth.
    setTasks((cur) =>
      cur.map((t) =>
        t.id === id && t.status === "blocked"
          ? { ...t, status: "queued", assigned_next: true, retry_count: (t.retry_count || 0) + 1 }
          : t
      )
    );
    await post(`/tasks/${id}/retry`, {});
  }

  async function promoteSc(id) {
    if (!apiOnline) {
      // local fallback: synthesize a ticket from the SC
      const sc = scs.find((s) => s.id === id);
      if (!sc) return;
      setTasks((cur) => [
        {
          id: `t-local-${Date.now()}`,
          text: sc.text,
          status: "queued",
          created_at: new Date().toISOString(),
          source: "sc-promote",
          cycle: sc.cycle,
        },
        ...cur,
      ]);
      setScs((cur) => cur.map((s) => (s.id === id ? { ...s, status: "promoted" } : s)));
      return;
    }
    const res = await apiFetch(token, `/suggested_changes/${id}/promote`, {
      method: "POST",
    });
    if (res.ok) loadAll();
  }

  // t-647: "Explain more" is a pure client-side expander (no ticket created).
  function toggleScExpanded(id) {
    setExpandedScIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // t-647: "Write a spec" enqueues a queued ticket asking the next drain to
  // write a spec for this Suggested Change. After POST success, flash a
  // confirmation on the row showing the new ticket id.
  async function requestSpecForSc(sc) {
    const scText = String(sc?.text || sc?.title || "").trim() || "(no suggestion text)";
    const ticketBody = {
      text: `Write a spec for the following Suggested Change: ${scText} (SC id: ${sc.id})`,
      source: "sc-spec-request",
      status: "queued",
      suggested_change_id: sc.id,
      cycle: sc.cycle,
    };
    if (!apiOnline) {
      const localId = `t-local-${Date.now()}`;
      setTasks((cur) => [
        {
          id: localId,
          created_at: new Date().toISOString(),
          ...ticketBody,
        },
        ...cur,
      ]);
      setScActionFlash((cur) => ({
        ...cur,
        [sc.id]: { text: `Spec queued (offline, ${localId})`, ticketId: localId, ts: Date.now() },
      }));
      setTimeout(() => {
        setScActionFlash((cur) => {
          const next = { ...cur };
          delete next[sc.id];
          return next;
        });
      }, 6000);
      return;
    }
    const created = await post("/tasks", ticketBody);
    const ticketId = created?.id || "queued";
    setScActionFlash((cur) => ({
      ...cur,
      [sc.id]: { text: `Spec queued as ${ticketId}`, ticketId, ts: Date.now() },
    }));
    setTimeout(() => {
      setScActionFlash((cur) => {
        const next = { ...cur };
        delete next[sc.id];
        return next;
      });
    }, 6000);
  }

  // t-667: Retry every blocked ticket back to queued. Sequenced (one at a time)
  // so we can show clear progress and avoid hammering the server.
  async function retryAllBlocked() {
    if (!apiOnline || retryAllProgress) return;
    const blocked = normTasks.filter((t) => t.status === "blocked");
    const total = blocked.length;
    if (total === 0) return;
    const ok = window.confirm(
      `Move all ${total} blocked ticket${total === 1 ? "" : "s"} back to Queued?`
    );
    if (!ok) return;
    setRetryAllMsg(null);
    setRetryAllProgress({ done: 0, total });
    let success = 0;
    let failed = 0;
    for (let i = 0; i < blocked.length; i++) {
      const t = blocked[i];
      try {
        const r = await apiFetch(token, `/tasks/${t.id}/retry`, {
          method: "POST",
        });
        if (r.ok) success++;
        else failed++;
      } catch {
        failed++;
      }
      setRetryAllProgress({ done: i + 1, total });
    }
    setRetryAllProgress(null);
    await loadAll();
    const msg = failed === 0
      ? `Retried ${success} ticket${success === 1 ? "" : "s"}`
      : `Retried ${success} of ${total} (${failed} failed)`;
    setRetryAllMsg(msg);
    setTimeout(() => setRetryAllMsg(null), 5000);
  }

  function dropSc(id) {
    setScs((cur) => cur.map((s) => (s.id === id ? { ...s, status: "dropped" } : s)));
    patch(`/suggested_changes/${id}`, { status: "dropped" });
  }

  function setFuDecision(id, decision) {
    setFus((cur) => cur.map((f) => (f.id === id ? { ...f, decision } : f)));
    patch(`/followups/${id}`, { decision });
  }

  async function buildSendReviewChecklist() {
    if (!apiOnline || sendReviewBuilding) return;
    setSendReviewBuilding(true);
    setSendReviewMsg(null);
    try {
      const res = await apiFetch(token, `/followups/send_review_checklist`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadAll();
      if (data.grouped > 0 && data.checklist?.id) {
        setSendReviewMsg(`Grouped ${data.grouped} into ${data.checklist.id}`);
      } else {
        setSendReviewMsg(data.message || "No eligible drafts");
      }
    } catch (err) {
      setSendReviewMsg(`Checklist failed: ${err.message || err}`);
    } finally {
      setSendReviewBuilding(false);
      setTimeout(() => setSendReviewMsg(null), 5000);
    }
  }

  function toggleSendReviewItem(checklistId, itemId) {
    const current = fus.find((f) => f.id === checklistId);
    if (!current) return;
    const checked = new Set(
      Array.isArray(current.checked_item_ids) ? current.checked_item_ids : []
    );
    if (checked.has(itemId)) {
      checked.delete(itemId);
    } else {
      checked.add(itemId);
    }
    const checkedItemIds = [...checked];
    setFus((cur) =>
      cur.map((f) =>
        f.id === checklistId ? { ...f, checked_item_ids: checkedItemIds } : f
      )
    );
    patch(`/followups/${checklistId}`, {
      checked_item_ids: checkedItemIds,
      updated_at: new Date().toISOString(),
    });
  }

  async function requestDrain(runtime) {
    const runtimeLabel = runtime === "codex" ? "Codex" : "Claude";
    const note = `manual ${runtime} trigger from dashboard at ${new Date().toISOString()}`;
    if (!apiOnline) {
      setPendingDrains((cur) => [
        {
          id: `pd-local-${Date.now()}`,
          status: "pending",
          requested_at: new Date().toISOString(),
          note,
          runtime,
        },
        ...cur,
      ]);
      setDrainQueuedAt(Date.now());
      setDrainFire({ mode: "queued", runtime, runtimeLabel, ts: Date.now() });
      return;
    }
    setDrainFiring(runtime);
    // Try the direct-fire endpoint first. If it 500s, fall back to queueing.
    try {
      const r = await apiFetch(token, `/drain/run`, {
        method: "POST",
        body: JSON.stringify({ prompt: "/ai-slaves", runtime }),
      });
      if (r.ok) {
        const data = await r.json();
        setDrainFire({ mode: "fired", runtime, runtimeLabel, pid: data.pid, ts: Date.now() });
        setDrainQueuedAt(Date.now());
        loadAll();
        return;
      }
      // 500 or other non-2xx: fall through to queue fallback below.
    } catch {
      // network/route missing: fall through
    } finally {
      setDrainFiring(null);
    }
    const res = await post("/pending_drains", { note, requested_at: new Date().toISOString(), runtime });
    if (res) {
      setDrainQueuedAt(Date.now());
      setDrainFire({ mode: "queued", runtime, runtimeLabel, ts: Date.now() });
    }
  }

  async function copyDrainCommand() {
    try {
      await navigator.clipboard.writeText("/ai-slaves");
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Clipboard write can fail on insecure contexts; silently ignore.
    }
  }

  async function clearAllDone() {
    if (!apiOnline || clearing) return;
    const doneTaskIds = tasks
      .filter((t) => normalizeStatus(t.status) === "done")
      .map((t) => t.id);
    const doneLogIds = doneLog.map((d) => d.id);
    const total = doneTaskIds.length + doneLogIds.length;
    if (total === 0) return;
    if (
      !window.confirm(
        `Delete ${total} done entries permanently? This cannot be undone.`
      )
    ) {
      return;
    }
    setClearing(true);
    // Two bulk-delete requests (one per collection) instead of N parallel
    // DELETEs. Server does one read+write per collection so we can't race
    // the JSON file or get lost updates.
    try {
      await Promise.all([
        apiFetch(token, `/tasks/_bulk_delete`, {
          method: "POST",
          body: JSON.stringify({ ids: doneTaskIds }),
        }),
        apiFetch(token, `/done_log/_bulk_delete`, {
          method: "POST",
          body: JSON.stringify({ ids: doneLogIds }),
        }),
      ]);
      await loadAll();
      setClearMsg(`Cleared ${total} entries`);
    } catch (err) {
      console.error("clearAllDone failed", err);
      setClearMsg(`Clear failed: ${err.message || err}`);
    } finally {
      setClearing(false);
      setTimeout(() => setClearMsg(null), 4000);
    }
  }

  // Derive ticket lanes
  const normTasks = useMemo(
    () => tasks.map((t) => ({ ...t, status: normalizeStatus(t.status) })),
    [tasks]
  );

  const filteredTickets = useMemo(() => {
    let list = normTasks;
    if (filter === "next-drain") list = list.filter((t) => t.assigned_next);
    if (filter === "mine") list = list.filter((t) => t.source === "dashboard");
    return list;
  }, [normTasks, filter]);

  const sortedTickets = useMemo(() => {
    const copy = [...filteredTickets];
    if (sortBy === "created") {
      copy.sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime()
      );
    } else if (sortBy === "cycle") {
      copy.sort((a, b) => (b.cycle || 0) - (a.cycle || 0));
    } else if (sortBy === "status") {
      const order = { queued: 0, in_progress: 1, blocked: 2, done: 3 };
      copy.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    }
    return copy;
  }, [filteredTickets, sortBy]);

  const lanes = useMemo(() => {
    const grouped = Object.fromEntries(TICKET_STATUSES.map((s) => [s, []]));
    for (const t of sortedTickets) {
      const s = grouped[t.status] ? t.status : "queued";
      grouped[s].push(t);
    }
    // Done lane always sorts oldest -> newest (t-119): things done first appear first.
    grouped.done.sort(
      (a, b) =>
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
    );
    return grouped;
  }, [sortedTickets]);

  const counts = useMemo(() => {
    return {
      queued: normTasks.filter((t) => t.status === "queued").length,
      in_progress: normTasks.filter((t) => t.status === "in_progress").length,
      blocked: normTasks.filter((t) => t.status === "blocked").length,
      done: normTasks.filter((t) => t.status === "done").length,
      open: normTasks.filter((t) => t.status !== "done").length,
    };
  }, [normTasks]);

  const doneItems = useMemo(() => {
    const doneTickets = normTasks
      .filter((t) => t.status === "done")
      .map((t) => ({
        key: `task-${t.id}`,
        id: t.id,
        text: t.text || t.title,
        cycle: t.cycle,
        created_at: t.created_at,
        handoff: t.handoff_path || t.handoff,
        campaign: t.campaign,
        origin: "task",
      }));
    const doneEntries = doneLog.map((d) => ({
      key: `log-${d.id}`,
      id: d.id,
      text: d.title || d.text,
      cycle: d.cycle,
      created_at: d.created_at,
      handoff: d.handoff_path || d.handoff,
      campaign: d.campaign,
      origin: "log",
    }));

    // Done stream sorts oldest -> newest (t-119): things done first appear first.
    return [...doneTickets, ...doneEntries].sort(
      (a, b) =>
        new Date(a.created_at || 0).getTime() -
        new Date(b.created_at || 0).getTime()
    );
  }, [normTasks, doneLog]);
  const doneTotal = doneItems.length;

  const pendingScs = scs.filter((s) => (s.status || "pending") === "pending");
  const decidedScs = scs.filter((s) => s.status === "promoted" || s.status === "dropped");
  // Decorate each followup with a best-effort handoff link inferred from done_log
  // (strategy b in the implementation plan: text-token overlap, same-cycle preferred).
  // Recompute when followups or done_log change so live drain writes show up.
  const fusWithHandoff = useMemo(() => {
    if (!fus || fus.length === 0) return fus;
    const recent = doneLog.slice(0, 50);
    return fus.map((f) => ({
      ...f,
      _matched_handoff: f.handoff_path || f.handoff || findMatchingHandoff(f, recent),
    }));
  }, [fus, doneLog]);
  const openFus = fusWithHandoff.filter((f) => !f.decision);
  const decidedFus = fusWithHandoff.filter((f) => f.decision);
  const sendReviewDrafts = useMemo(
    () => openFus.filter(isSendReviewDraftFollowup),
    [openFus]
  );

  const runningAgents = agents.filter((a) => (a.status || "running") === "running");
  const recentAgents = agents
    .filter((a) => a.status !== "running")
    .slice(0, 8);
  const recentDrains = useMemo(() => {
    return [...pendingDrains]
      .sort(
        (a, b) =>
          new Date(b.requested_at || b.created_at || 0).getTime() -
          new Date(a.requested_at || a.created_at || 0).getTime()
      )
      .slice(0, 8);
  }, [pendingDrains]);
  const launchAgents = schedulerInfo?.launch_agents || [];
  const schedulerLogs = (schedulerInfo?.logs || []).filter((log) => log.exists);
  const scheduleCount =
    launchAgents.length + recentDrains.length + (schedulerInfo?.pid_file?.exists ? 1 : 0);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-title">
              AI Slaves <span className="brand-sub">Power Doc</span>
            </div>
            <div className="brand-tag">tickets, suggestions, decisions, all your agents</div>
          </div>
        </div>
        <div className="top-stats">
          <div className="stat">
            <div className="stat-num">{counts.open}</div>
            <div className="stat-lbl">open</div>
          </div>
          <div className="stat">
            <div className="stat-num">{counts.in_progress}</div>
            <div className="stat-lbl">in flight</div>
          </div>
          <div className="stat">
            <div className="stat-num">{runningAgents.length}</div>
            <div className="stat-lbl">agents</div>
          </div>
          <div className={`status-pill ${apiOnline ? "" : "offline"}`}>
            <span className="dot"></span>
            {loading ? "syncing" : apiOnline ? "live" : "read-only"}
          </div>
          {token && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={onSignOut}
              title="Forget the saved DASHBOARD_TOKEN and lock the dashboard."
            >
              sign out
            </button>
          )}
        </div>
      </header>

      <div className="add-bar">
        <textarea
          ref={ticketInputRef}
          className="ticket-input"
          placeholder="New ticket. Prefix with 'campaign:<id> ' to tag. Enter to submit, Shift+Enter for newline."
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              addTicket();
            }
          }}
          rows={3}
        />
        <button className="btn" onClick={addTicket} disabled={!newTask.trim()}>
          Add ticket
        </button>
        <button className="btn btn-ghost" onClick={loadAll} title="Force refresh (auto-refreshes every 5s)">
          Refresh
        </button>
      </div>

      <div className="drain-bar">
        <div className="drain-bar-left">
          <button
            className="btn btn-drain"
            onClick={() => requestDrain("claude")}
            disabled={!!drainFiring}
            title="Spawns a detached `claude` stream-json session and pipes /ai-slaves over stdin. No -p flag. Falls back to queueing if the endpoint is unavailable."
          >
            {drainFiring === "claude" ? "Firing Claude..." : "Run drain now for Claude"}
          </button>
          <button
            className="btn btn-drain btn-drain-codex"
            onClick={() => requestDrain("codex")}
            disabled={!!drainFiring}
            title="Spawns a detached `codex exec` session with /ai-slaves. Falls back to queueing if the endpoint is unavailable."
          >
            {drainFiring === "codex" ? "Firing Codex..." : "Run drain now for Codex"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={copyDrainCommand}
            title="Copy /ai-slaves to clipboard"
          >
            {copiedCmd ? "Copied" : "Copy /ai-slaves"}
          </button>
          {pendingDrains.filter((d) => (d.status || "pending") === "pending").length > 0 && (
            <span className="chip chip--accent">
              Pending: {pendingDrains.filter((d) => (d.status || "pending") === "pending").length}
            </span>
          )}
        </div>
        {drainFire && Date.now() - drainFire.ts < 12000 ? (
          drainFire.mode === "fired" ? (
            <div className="drain-confirm">
              {drainFire.runtimeLabel} drain firing... (PID {drainFire.pid}). Tail <span className="kbd">logs/drain-*.log</span> to watch output.
            </div>
          ) : (
            <div className="drain-confirm">
              Endpoint unavailable, {drainFire.runtimeLabel} request queued. Run <span className="kbd">/ai-slaves</span> in {drainFire.runtimeLabel} to pick it up.
            </div>
          )
        ) : (
          <div className="drain-hint">
            Spawns a detached Claude or Codex session with <span className="kbd">/ai-slaves</span>. Falls back to queueing if the headless endpoint fails.
          </div>
        )}
      </div>

      <Section
        title="Tickets"
        count={counts.open}
        action={
          <div className="controls">
            <div className="seg">
              <button className={view === "board" ? "is-on" : ""} onClick={() => setView("board")}>
                board
              </button>
              <button className={view === "list" ? "is-on" : ""} onClick={() => setView("list")}>
                list
              </button>
            </div>
            <div className="seg">
              <button className={filter === "all" ? "is-on" : ""} onClick={() => setFilter("all")}>
                all
              </button>
              <button
                className={filter === "next-drain" ? "is-on" : ""}
                onClick={() => setFilter("next-drain")}
              >
                next drain
              </button>
              <button className={filter === "mine" ? "is-on" : ""} onClick={() => setFilter("mine")}>
                from dashboard
              </button>
            </div>
            <select
              className="sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="created">sort: created</option>
              <option value="cycle">sort: cycle</option>
              <option value="status">sort: status</option>
            </select>
          </div>
        }
      >
        {view === "board" ? (
          <div className="board">
            {TICKET_STATUSES.map((s) => (
              <Lane
                key={s}
                status={s}
                tickets={lanes[s]}
                onMove={moveTicket}
                onDelete={deleteTicket}
                onAssignNext={setAssignNext}
                onRetry={retryTicket}
                headAction={
                  s === "done" && lanes.done.length > 0 ? (
                    <>
                      <button
                        className={`btn btn-ghost btn-xs lane-toggle-btn ${
                          doneMinimized ? "is-on" : ""
                        }`}
                        onClick={() => setDoneMinimized((v) => !v)}
                        title={doneMinimized ? "Show done entries" : "Minimize done entries"}
                      >
                        {doneMinimized ? "show" : "hide"}
                      </button>
                      <button
                        className="btn btn-ghost btn-xs lane-clear-btn"
                        onClick={clearAllDone}
                        disabled={clearing || !apiOnline}
                        title="Permanently delete every done ticket + done_log entry"
                      >
                        {clearing ? "..." : "clear"}
                      </button>
                    </>
                  ) : s === "blocked" && lanes.blocked.length > 0 ? (
                    <>
                      {retryAllMsg && (
                        <span className="clear-toast" title="Retry all blocked result">
                          {retryAllMsg}
                        </span>
                      )}
                      <button
                        className="btn btn-success btn-xs lane-retry-all-btn"
                        onClick={retryAllBlocked}
                        disabled={!apiOnline || !!retryAllProgress}
                        title="Flip every blocked ticket back to Queued so the next drain picks them up"
                      >
                        {retryAllProgress
                          ? `Retrying ${retryAllProgress.done}/${retryAllProgress.total}...`
                          : `Retry all (${lanes.blocked.length})`}
                      </button>
                    </>
                  ) : null
                }
                collapsed={s === "done" && doneMinimized}
              />
            ))}
          </div>
        ) : (
          <div className="ticket-list">
            {sortedTickets.length === 0 ? (
              <div className="empty">No tickets match this filter.</div>
            ) : (
              sortedTickets.map((t) => (
                <TicketCard
                  key={t.id}
                  ticket={t}
                  onMove={moveTicket}
                  onDelete={deleteTicket}
                  onAssignNext={setAssignNext}
                  onRetry={retryTicket}
                />
              ))
            )}
          </div>
        )}
      </Section>

      <div className="grid">
        <div className="col">
          <Section title="Suggested Changes" count={pendingScs.length} collapsible defaultCollapsed={isMobile}>
            {pendingScs.length === 0 ? (
              <div className="empty">No pending suggestions.</div>
            ) : (
              <ul className="card-list">
                {pendingScs.map((s) => {
                  const isExpanded = expandedScIds.has(s.id);
                  const flash = scActionFlash[s.id];
                  return (
                    <li key={s.id} className="card">
                      <div className="card-text">{s.text}</div>
                      {isExpanded && (
                        <div className="sc-expanded">
                          <div className="sc-expanded-label">Full text</div>
                          <div className="sc-expanded-body">{s.text}</div>
                          {s.revenue_mechanism && (
                            <div className="sc-expanded-row">
                              <strong>Revenue:</strong> {s.revenue_mechanism}
                            </div>
                          )}
                          {s.source_task_id && (
                            <div className="sc-expanded-row">
                              <strong>Source task:</strong> {s.source_task_id}
                            </div>
                          )}
                          {s.created_at && (
                            <div className="sc-expanded-row">
                              <strong>Created:</strong> {fmtDate(s.created_at)} {fmtTime(s.created_at)}
                            </div>
                          )}
                        </div>
                      )}
                      {s.revenue_mechanism && (
                        <div className="card-revenue">
                          <strong>Revenue</strong>
                          {s.revenue_mechanism}
                        </div>
                      )}
                      <div className="card-footer">
                        <div className="card-meta">
                          {s.cycle != null && <span className="chip">cycle {s.cycle}</span>}
                          <span className="chip">{s.id}</span>
                          {flash && (
                            <span className="clear-toast" title="Spec ticket queued">
                              {flash.text}
                            </span>
                          )}
                        </div>
                        <div className="card-buttons">
                          <button
                            className={`btn btn-ghost btn-sm ${isExpanded ? "is-on" : ""}`}
                            onClick={() => toggleScExpanded(s.id)}
                            title="Show or hide the full Suggested Change details"
                          >
                            {isExpanded ? "Show less" : "Explain more"}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => requestSpecForSc(s)}
                            title="Queue a ticket asking the next drain to write a spec for this SC"
                            disabled={!!flash}
                          >
                            {flash ? "Queued" : "Write a spec"}
                          </button>
                          <button
                            className="btn btn-success btn-sm"
                            onClick={() => promoteSc(s.id)}
                            title="Create a queued ticket from this SC"
                          >
                            Promote to ticket
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => dropSc(s.id)}
                          >
                            Drop
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {decidedScs.length > 0 && (
              <details className="archive">
                <summary>{decidedScs.length} decided</summary>
                <ul className="card-list">
                  {decidedScs.map((s) => (
                    <li key={s.id} className="card card--muted">
                      <div className="card-text">{s.text}</div>
                      <div className="card-meta">
                        <span className={`pill pill--${s.status}`}>{statusLabel(s.status)}</span>
                        {s.cycle != null && <span className="chip">cycle {s.cycle}</span>}
                        {s.promoted_to && (
                          <span className="chip chip--accent">to {s.promoted_to}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>

          <Section
            title="Follow-up"
            count={openFus.length}
            collapsible
            defaultCollapsed={isMobile}
            action={
              <div className="send-review-actions">
                {sendReviewMsg && <span className="clear-toast">{sendReviewMsg}</span>}
                <button
                  className="btn btn-success btn-sm"
                  onClick={buildSendReviewChecklist}
                  disabled={!apiOnline || sendReviewBuilding || sendReviewDrafts.length === 0}
                  title="Group eligible Gmail draft follow-ups into one review checklist. This does not send email."
                >
                  {sendReviewBuilding
                    ? "Grouping..."
                    : `Build send-review checklist (${sendReviewDrafts.length})`}
                </button>
              </div>
            }
          >
            {openFus.length === 0 ? (
              <div className="empty">No open decisions.</div>
            ) : (
              <ul className="card-list">
                {openFus.map((f) => {
                  const isSendReviewChecklist =
                    f.kind === SEND_REVIEW_CHECKLIST_KIND;
                  const checklistItems = Array.isArray(f.checklist_items)
                    ? f.checklist_items
                    : [];
                  const checkedIds = new Set(
                    Array.isArray(f.checked_item_ids) ? f.checked_item_ids : []
                  );
                  const checkedCount = checklistItems.filter((item) =>
                    checkedIds.has(item.followup_id || item.id)
                  ).length;
                  return (
                    <li
                      key={f.id}
                      className={`card ${isSendReviewChecklist ? "card--checklist" : ""}`}
                    >
                      <div className="card-text">{f.text || f.question || f.title}</div>
                      {isSendReviewChecklist ? (
                        <div className="send-review-list">
                          {checklistItems.length === 0 ? (
                            <div className="empty empty--compact">
                              No drafts in this checklist yet.
                            </div>
                          ) : (
                            checklistItems.map((item) => {
                              const itemId = item.followup_id || item.id;
                              const isChecked = checkedIds.has(itemId);
                              return (
                                <div
                                  key={itemId}
                                  className={`send-review-item ${
                                    isChecked ? "is-checked" : ""
                                  }`}
                                >
                                  <label className="send-review-check">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() =>
                                        toggleSendReviewItem(f.id, itemId)
                                      }
                                    />
                                    <span className="send-review-item-text">
                                      {item.text}
                                    </span>
                                  </label>
                                  <div className="send-review-item-meta">
                                    <span className="chip">{itemId}</span>
                                    {item.draft_id && (
                                      <span className="chip">{item.draft_id}</span>
                                    )}
                                    {item.subject && (
                                      <span className="chip" title={item.subject}>
                                        {item.subject}
                                      </span>
                                    )}
                                    {item.cycle != null && (
                                      <span className="chip">cycle {item.cycle}</span>
                                    )}
                                    {item.handoff && (
                                      <a
                                        className="chip chip--link"
                                        href={reportHref(item.handoff)}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={item.handoff}
                                      >
                                        handoff
                                      </a>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      ) : (
                        <ul className="option-list">
                          {(f.decision_options || f.options || []).map((opt) => (
                            <li
                              key={opt}
                              className={`option ${f.decision === opt ? "selected" : ""}`}
                              onClick={() => setFuDecision(f.id, opt)}
                            >
                              <span className="option-marker"></span>
                              <span>{opt}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {isSendReviewChecklist && (
                        <ul className="option-list">
                          {(f.decision_options || f.options || []).map((opt) => (
                            <li
                              key={opt}
                              className={`option ${f.decision === opt ? "selected" : ""}`}
                              onClick={() => setFuDecision(f.id, opt)}
                            >
                              <span className="option-marker"></span>
                              <span>{opt}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="card-meta">
                        {isSendReviewChecklist && (
                          <span className="chip chip--accent">
                            {checkedCount}/{checklistItems.length} checked
                          </span>
                        )}
                        {f.cycle != null && (
                          <span className="chip">cycle {f.cycle}</span>
                        )}
                        <span className="chip">{f.id}</span>
                        {f._matched_handoff && (
                          <a
                            className="chip chip--link"
                            href={reportHref(f._matched_handoff)}
                            target="_blank"
                            rel="noreferrer"
                            title={f._matched_handoff}
                          >
                            view handoff
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {decidedFus.length > 0 && (
              <details className="archive">
                <summary>{decidedFus.length} decided</summary>
                <ul className="card-list">
                  {decidedFus.map((f) => (
                    <li key={f.id} className="card card--muted">
                      <div className="card-text">{f.text || f.question || f.title}</div>
                      <div className="card-meta">
                        <span className="chip chip--accent">{f.decision}</span>
                        {f.cycle != null && <span className="chip">cycle {f.cycle}</span>}
                        {f._matched_handoff && (
                          <a
                            className="chip chip--link"
                            href={reportHref(f._matched_handoff)}
                            target="_blank"
                            rel="noreferrer"
                            title={f._matched_handoff}
                          >
                            view handoff
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>
        </div>

        <div className="col">
          <Section
            title="Recently Created HTMLs"
            count={recentHandoffs.length}
            collapsible
            defaultCollapsed={isMobile}
            action={
              <span className="done-order-hint">newest -&gt; oldest</span>
            }
          >
            {recentHandoffs.length === 0 ? (
              <div className="empty">No handoff HTMLs yet.</div>
            ) : (
              <div className="handoff-list">
                {recentHandoffs.map((h) => (
                  <a
                    key={h.filename}
                    className="handoff-row"
                    href={h.relative_url}
                    target="_blank"
                    rel="noreferrer"
                    title={h.filename}
                  >
                    <span className="handoff-name">
                      {prettyHandoffName(h.filename)}
                    </span>
                    <span className="handoff-time">{fmtRelative(h.mtime_iso)}</span>
                  </a>
                ))}
              </div>
            )}
          </Section>

          <Section title="Agents" count={runningAgents.length} collapsible defaultCollapsed={isMobile}>
            {agents.length === 0 ? (
              <div className="empty">
                No agents reporting in yet. The orchestrator will write here once cycle 16 lands.
                File: <span className="kbd">data/agents.json</span>
              </div>
            ) : (
              <>
                {runningAgents.length > 0 && (
                  <div className="agent-list">
                    {runningAgents.map((a) => (
                      <div key={a.id} className="agent-row agent-row--running">
                        <span className="agent-dot" />
                        <div className="agent-body">
                          <div className="agent-title">{a.task_title || a.title || "(no title)"}</div>
                          <div className="agent-meta">
                            <span className="chip">{a.agentId || a.id}</span>
                            {a.drain_cycle_id != null && (
                              <span className="chip">cycle {a.drain_cycle_id}</span>
                            )}
                            {a.spawned_at && (
                              <span className="chip">spawned {fmtTime(a.spawned_at)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {recentAgents.length > 0 && (
                  <details className="archive" open>
                    <summary>{recentAgents.length} recent</summary>
                    <div className="agent-list">
                      {recentAgents.map((a) => (
                        <div key={a.id} className="agent-row">
                          <span className={`pill pill--${a.status}`}>
                            {statusLabel(a.status)}
                          </span>
                          <div className="agent-body">
                            <div className="agent-title">
                              {a.task_title || a.title || "(no title)"}
                            </div>
                            <div className="agent-meta">
                              <span className="chip">{a.agentId || a.id}</span>
                              {a.drain_cycle_id != null && (
                                <span className="chip">cycle {a.drain_cycle_id}</span>
                              )}
                              {a.completed_at && (
                                <span className="chip">done {fmtTime(a.completed_at)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </Section>

          <Section
            title="Recently Done"
            count={doneTotal}
            collapsible
            defaultCollapsed={isMobile}
            action={
              <div className="done-actions">
                {clearMsg && (
                  <span className="clear-toast">{clearMsg}</span>
                )}
                <span className="done-order-hint">
                  {doneMinimized ? "minimized" : "oldest -&gt; newest"}
                </span>
                <button
                  className={`btn btn-ghost btn-sm ${doneMinimized ? "is-on" : ""}`}
                  onClick={() => setDoneMinimized((v) => !v)}
                  disabled={doneTotal === 0}
                  title={doneMinimized ? "Show done entries" : "Minimize done entries"}
                >
                  {doneMinimized ? "Show done" : "Minimize"}
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={clearAllDone}
                  disabled={clearing || !apiOnline || doneTotal === 0}
                  title="Permanently delete every done ticket + done_log entry"
                >
                  {clearing ? "Clearing..." : "Clear all done"}
                </button>
              </div>
            }
          >
            {doneItems.length === 0 ? (
              <div className="empty">Nothing closed yet.</div>
            ) : doneMinimized ? (
              <div className="done-minimized">
                <span className="pill pill--done">done</span>
                <span>{doneTotal} done entries hidden.</span>
              </div>
            ) : (
              <div className="done-list">
                {doneItems.map((d) => {
                  const color = campaignColor(d.campaign);
                  const rowStyle = color
                    ? { borderLeft: `3px solid ${color.border}`, background: color.soft, paddingLeft: 8 }
                    : undefined;
                  return (
                    <div key={d.key} className="done-row" style={rowStyle}>
                      <span className="pill pill--done">done</span>
                      <span className="done-text">{d.text}</span>
                      {d.campaign && (
                        <span
                          className="chip chip--campaign"
                          style={{
                            color: color?.text,
                            borderColor: color?.border,
                            background: color?.soft,
                          }}
                        >
                          {d.campaign}
                        </span>
                      )}
                      {d.cycle != null && (
                        <span className="chip">cycle {d.cycle}</span>
                      )}
                      {d.created_at && (
                        <span className="chip">{fmtDate(d.created_at)}</span>
                      )}
                      {d.handoff && (
                        <a
                          className="chip chip--link"
                          href={reportHref(d.handoff)}
                          target="_blank"
                          rel="noreferrer"
                          title={d.handoff}
                        >
                          handoff
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>

      <Section
        title="Scheduled"
        count={scheduled.length}
        collapsible
        defaultCollapsed={isMobile}
        action={
          <span className="done-order-hint">in-session crons + remote routines</span>
        }
      >
        {scheduled.length === 0 ? (
          <div className="empty">
            No scheduled entries. Register one with{" "}
            <span className="kbd">
              curl -X POST http://127.0.0.1:5176/api/scheduled -H 'Content-Type: application/json' -d '{`{`}...{`}`}'
            </span>
          </div>
        ) : (
          <div className="scheduled-table">
            <div className="scheduled-row scheduled-row--head">
              <div>Name</div>
              <div>Cadence</div>
              <div>Next run</div>
              <div>Source</div>
              <div>Status</div>
              <div>Description</div>
            </div>
            {scheduled.map((s) => {
              const status = s.status || "enabled";
              return (
                <div key={s.id} className="scheduled-row">
                  <div className="scheduled-name">
                    {s.name || "(unnamed)"}
                    {s.job_id && (
                      <div className="scheduled-job-id" title={s.job_id}>
                        {s.job_id}
                      </div>
                    )}
                  </div>
                  <div>
                    <code className="scheduled-cadence">{s.cadence || ""}</code>
                    {s.cadence_type && (
                      <div className="scheduled-cadence-type">{s.cadence_type}</div>
                    )}
                  </div>
                  <div>{s.next_run ? fmtRelative(s.next_run) : <span className="text-faint">recurring</span>}</div>
                  <div>{s.source || ""}</div>
                  <div>
                    <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
                  </div>
                  <div className="scheduled-desc">{s.description || ""}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Scheduled Runs" count={scheduleCount} collapsible defaultCollapsed={isMobile}>
        {!schedulerInfo ? (
          <div className="empty">
            Scheduler details need the API server. Recent pending drains still load from local JSON when available.
          </div>
        ) : (
          <div className="schedule-layout">
            <div className="schedule-block">
              <div className="schedule-block-title">Scheduler status</div>
              <div className="schedule-status">
                <span className={`pill pill--${schedulerInfo.pid_file?.status || "missing"}`}>
                  {statusLabel(schedulerInfo.pid_file?.status || "missing")}
                </span>
                {schedulerInfo.pid_file?.pid && (
                  <span className="chip">pid {schedulerInfo.pid_file.pid}</span>
                )}
                {schedulerInfo.pid_file?.relative_path && (
                  <span className="chip" title={schedulerInfo.pid_file.path}>
                    {schedulerInfo.pid_file.relative_path}
                  </span>
                )}
                {schedulerInfo.pid_file?.process?.interval_seconds && (
                  <span className="chip">
                    loop {fmtInterval(schedulerInfo.pid_file.process.interval_seconds)}
                    {schedulerInfo.pid_file.process.jitter_seconds
                      ? ` +${fmtInterval(schedulerInfo.pid_file.process.jitter_seconds)} jitter`
                      : ""}
                  </span>
                )}
              </div>
              <div className="schedule-note">{schedulerInfo.schedule_model?.detail}</div>
              {schedulerInfo.pid_file?.process?.started_at_text && (
                <div className="schedule-note">
                  Process started {schedulerInfo.pid_file.process.started_at_text}
                </div>
              )}
              {schedulerInfo.pid_file?.process?.command && (
                <div className="schedule-command" title={schedulerInfo.pid_file.process.command}>
                  {schedulerInfo.pid_file.process.command}
                </div>
              )}
            </div>

            <div className="schedule-block">
              <div className="schedule-block-title">Launch schedules</div>
              {launchAgents.length === 0 ? (
                <div className="empty empty--compact">No launchd schedule plist found.</div>
              ) : (
                <div className="schedule-list">
                  {launchAgents.map((agent) => {
                    const state = agent.launchctl?.state || (agent.launchctl?.loaded ? "loaded" : "missing");
                    const stateClass = state === "running" ? "running" : agent.launchctl?.loaded ? "loaded" : "missing";
                    const interval = agent.start_interval_seconds || agent.launchctl?.run_interval_seconds;
                    return (
                      <div key={agent.label} className="schedule-row">
                        <span className={`pill pill--${stateClass}`}>
                          {state === "not running" ? "Idle" : statusLabel(state)}
                        </span>
                        <div className="schedule-row-body">
                          <div className="schedule-row-title">{agent.label}</div>
                          <div className="schedule-row-meta">
                            {interval && <span className="chip">every {fmtInterval(interval)}</span>}
                            {agent.launchctl?.runs != null && (
                              <span className="chip">{agent.launchctl.runs} runs</span>
                            )}
                            {agent.launchctl?.last_exit_code != null && (
                              <span className="chip">last exit {agent.launchctl.last_exit_code}</span>
                            )}
                            <span className="chip" title={agent.path}>
                              {fileName(agent.path)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="schedule-block schedule-block--wide">
              <div className="schedule-block-title">Recent drain requests</div>
              {recentDrains.length === 0 ? (
                <div className="empty empty--compact">No pending_drains entries yet.</div>
              ) : (
                <div className="run-list">
                  {recentDrains.map((drain) => {
                    const status = drain.status || "pending";
                    return (
                      <div key={drain.id} className="run-row">
                        <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
                        <div className="run-body">
                          <div className="run-title">
                            {drain.runtime || "drain"}
                            {drain.mode ? `, ${drain.mode}` : ""}
                          </div>
                          <div className="run-meta">
                            {drain.requested_at && (
                              <span className="chip">{fmtRelative(drain.requested_at)}</span>
                            )}
                            {drain.pid && <span className="chip">pid {drain.pid}</span>}
                            <span className="chip">{drain.id}</span>
                            {drain.log_path && (
                              <a
                                className="chip chip--link"
                                href={`file://${drain.log_path}`}
                                target="_blank"
                                rel="noreferrer"
                                title={drain.log_path}
                              >
                                {fileName(drain.log_path)}
                              </a>
                            )}
                          </div>
                          {drain.note && <div className="schedule-note">{drain.note}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="schedule-block schedule-block--wide">
              <div className="schedule-block-title">Scheduler logs</div>
              {schedulerLogs.length === 0 ? (
                <div className="empty empty--compact">No scheduler log files found.</div>
              ) : (
                <div className="log-list">
                  {schedulerLogs.map((log) => (
                    <a
                      key={log.path}
                      className="log-row"
                      href={`file://${log.path}`}
                      target="_blank"
                      rel="noreferrer"
                      title={log.path}
                    >
                      <span className="log-name">{log.relative_path || fileName(log.path)}</span>
                      <span className="chip">{log.size || 0} bytes</span>
                      {log.mtime_iso && <span className="chip">{fmtRelative(log.mtime_iso)}</span>}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Section>

      <div className="footnote">
        Data lives at <span className="kbd">~/Desktop/Ai-slaves-dashboard/data/</span>. The /ai-slaves
        drain mirrors writes here in parallel with the Google Doc. Vite :5179, Express :5176.
      </div>
    </div>
  );
}
