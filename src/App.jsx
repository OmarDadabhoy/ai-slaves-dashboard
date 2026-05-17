import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";

const API = "/api";

const TICKET_STATUSES = ["queued", "in_progress", "blocked", "done"];

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

function Section({ title, count, action, children }) {
  return (
    <section className="section">
      <div className="section-header">
        <div className="section-title">
          <span>{title}</span>
          {typeof count === "number" && <span className="count">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function TicketCard({ ticket, onMove, onDelete, onAssignNext }) {
  const status = normalizeStatus(ticket.status);
  const body = ticket.text || ticket.title || "(untitled)";
  const color = campaignColor(ticket.campaign);
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
        {ticket.handoff_path && (
          <a
            className="chip chip--link"
            href={`file://${ticket.handoff_path}`}
            target="_blank"
            rel="noreferrer"
          >
            handoff
          </a>
        )}
        {ticket.handoff && (
          <a
            className="chip chip--link"
            href={
              ticket.handoff.startsWith("http")
                ? ticket.handoff
                : `file://${ticket.handoff}`
            }
            target="_blank"
            rel="noreferrer"
          >
            handoff
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

function Lane({ status, tickets, onMove, onDelete, onAssignNext, headAction }) {
  return (
    <div className="lane">
      <div className="lane-head">
        <span className={`pill pill--${status}`}>{statusLabel(status)}</span>
        <div className="lane-head-right">
          <span className="lane-count">{tickets.length}</span>
          {headAction}
        </div>
      </div>
      <div className="lane-body">
        {tickets.length === 0 ? (
          <div className="lane-empty">empty</div>
        ) : (
          tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              onMove={onMove}
              onDelete={onDelete}
              onAssignNext={onAssignNext}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [scs, setScs] = useState([]);
  const [fus, setFus] = useState([]);
  const [doneLog, setDoneLog] = useState([]);
  const [agents, setAgents] = useState([]);
  const [pendingDrains, setPendingDrains] = useState([]);
  const [recentHandoffs, setRecentHandoffs] = useState([]);
  const [newTask, setNewTask] = useState("");
  const [apiOnline, setApiOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // all | mine | next-drain
  const [sortBy, setSortBy] = useState("created"); // created | cycle | status
  const [view, setView] = useState("board"); // board | list
  const [drainQueuedAt, setDrainQueuedAt] = useState(null);
  const [drainFire, setDrainFire] = useState(null); // { mode: 'fired'|'queued', runtime, pid?, ts }
  const [drainFiring, setDrainFiring] = useState(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [clearMsg, setClearMsg] = useState(null);
  const [clearing, setClearing] = useState(false);

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
    setLoading(true);
    try {
      const [tRes, sRes, fRes, dRes, aRes, pdRes, rhRes] = await Promise.all([
        fetch(`${API}/tasks`),
        fetch(`${API}/suggested_changes`),
        fetch(`${API}/followups`),
        fetch(`${API}/done_log`),
        fetch(`${API}/agents`),
        fetch(`${API}/pending_drains`),
        fetch(`${API}/recent_handoffs?limit=10`),
      ]);
      if (tRes.ok) setTasks(await tRes.json());
      if (sRes.ok) setScs(await sRes.json());
      if (fRes.ok) setFus(await fRes.json());
      if (dRes.ok) setDoneLog(await dRes.json());
      if (aRes.ok) setAgents(await aRes.json());
      if (pdRes.ok) setPendingDrains(await pdRes.json());
      if (rhRes.ok) setRecentHandoffs(await rhRes.json());
      setApiOnline(true);
    } catch {
      setApiOnline(false);
      try {
        const [t, s, f, d, a] = await Promise.all([
          fetch("/data/tasks.json").then((r) => (r.ok ? r.json() : [])),
          fetch("/data/suggested_changes.json").then((r) => (r.ok ? r.json() : [])),
          fetch("/data/followups.json").then((r) => (r.ok ? r.json() : [])),
          fetch("/data/done_log.json").then((r) => (r.ok ? r.json() : [])),
          fetch("/data/agents.json").then((r) => (r.ok ? r.json() : [])),
        ]);
        setTasks(t);
        setScs(s);
        setFus(f);
        setDoneLog(d);
        setAgents(a);
      } catch {}
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 5000); // soft refresh so orchestrator writes appear live
    return () => clearInterval(id);
  }, [loadAll]);

  async function patch(path, body) {
    if (!apiOnline) return;
    const res = await fetch(`${API}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) loadAll();
  }

  async function post(path, body) {
    if (!apiOnline) return null;
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${API}${path}`, { method: "DELETE" });
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
    const body = { text, source: "dashboard" };
    if (campaign) body.campaign = campaign;
    await post("/tasks", body);
    setNewTask("");
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
    const res = await fetch(`${API}/suggested_changes/${id}/promote`, {
      method: "POST",
    });
    if (res.ok) loadAll();
  }

  function dropSc(id) {
    setScs((cur) => cur.map((s) => (s.id === id ? { ...s, status: "dropped" } : s)));
    patch(`/suggested_changes/${id}`, { status: "dropped" });
  }

  function setFuDecision(id, decision) {
    setFus((cur) => cur.map((f) => (f.id === id ? { ...f, decision } : f)));
    patch(`/followups/${id}`, { decision });
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
      const r = await fetch(`${API}/drain/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        fetch(`${API}/tasks/_bulk_delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: doneTaskIds }),
        }),
        fetch(`${API}/done_log/_bulk_delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

  const runningAgents = agents.filter((a) => (a.status || "running") === "running");
  const recentAgents = agents
    .filter((a) => a.status !== "running")
    .slice(0, 8);

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
                headAction={
                  s === "done" && lanes.done.length > 0 ? (
                    <button
                      className="btn btn-ghost btn-xs lane-clear-btn"
                      onClick={clearAllDone}
                      disabled={clearing || !apiOnline}
                      title="Permanently delete every done ticket + done_log entry"
                    >
                      {clearing ? "..." : "clear"}
                    </button>
                  ) : null
                }
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
                />
              ))
            )}
          </div>
        )}
      </Section>

      <div className="grid">
        <div className="col">
          <Section title="Suggested Changes" count={pendingScs.length}>
            {pendingScs.length === 0 ? (
              <div className="empty">No pending suggestions.</div>
            ) : (
              <ul className="card-list">
                {pendingScs.map((s) => (
                  <li key={s.id} className="card">
                    <div className="card-text">{s.text}</div>
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
                      </div>
                      <div className="card-buttons">
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
                ))}
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

          <Section title="Follow-up" count={openFus.length}>
            {openFus.length === 0 ? (
              <div className="empty">No open decisions.</div>
            ) : (
              <ul className="card-list">
                {openFus.map((f) => (
                  <li key={f.id} className="card">
                    <div className="card-text">{f.text || f.question || f.title}</div>
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
                    <div className="card-meta">
                      {f.cycle != null && (
                        <span className="chip">cycle {f.cycle}</span>
                      )}
                      <span className="chip">{f.id}</span>
                      {f._matched_handoff && (
                        <a
                          className="chip chip--link"
                          href={
                            f._matched_handoff.startsWith("http")
                              ? f._matched_handoff
                              : `/reports/${encodeURIComponent(
                                  f._matched_handoff.split("/").pop()
                                )}`
                          }
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
                            href={
                              f._matched_handoff.startsWith("http")
                                ? f._matched_handoff
                                : `/reports/${encodeURIComponent(
                                    f._matched_handoff.split("/").pop()
                                  )}`
                            }
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

          <Section title="Agents" count={runningAgents.length}>
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
            count={normTasks.filter((t) => t.status === "done").length + doneLog.length}
            action={
              <div className="done-actions">
                {clearMsg && (
                  <span className="clear-toast">{clearMsg}</span>
                )}
                <span className="done-order-hint">oldest -&gt; newest</span>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={clearAllDone}
                  disabled={
                    clearing ||
                    !apiOnline ||
                    normTasks.filter((t) => t.status === "done").length +
                      doneLog.length ===
                      0
                  }
                  title="Permanently delete every done ticket + done_log entry"
                >
                  {clearing ? "Clearing..." : "Clear all done"}
                </button>
              </div>
            }
          >
            {(() => {
              // Merge done tasks + done_log entries into a single chronological stream,
              // sorted ASC by created_at so "stuff done first" appears at the top (t-119).
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
              const merged = [...doneTickets, ...doneEntries].sort(
                (a, b) =>
                  new Date(a.created_at || 0).getTime() -
                  new Date(b.created_at || 0).getTime()
              );
              if (merged.length === 0) {
                return <div className="empty">Nothing closed yet.</div>;
              }
              return (
                <div className="done-list">
                  {merged.map((d) => {
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
                            href={
                              d.handoff.startsWith("http")
                                ? d.handoff
                                : `file://${d.handoff}`
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            handoff
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </Section>
        </div>
      </div>

      <div className="footnote">
        Data lives at <span className="kbd">~/Desktop/Ai-slaves-dashboard/data/</span>. The /ai-slaves
        drain mirrors writes here in parallel with the Google Doc. Vite :5179, Express :5176.
      </div>
    </div>
  );
}
