// Single-user dashboard token gate. The Vercel deployment is configured
// with a DASHBOARD_TOKEN env var. The frontend stores the token in
// localStorage and sends it on every API call as x-dashboard-token.
//
// Local dev (server.js) never enforces the token; that path is unchanged.

export function checkToken(req, res) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) {
    // No token configured: open mode. Useful for `vercel dev` if Omar
    // hasn't set the env yet. Logs a warning so we know.
    console.warn("[auth] DASHBOARD_TOKEN not set, allowing all requests");
    return true;
  }
  const supplied =
    req.headers["x-dashboard-token"] ||
    req.headers["X-Dashboard-Token"] ||
    "";
  if (supplied === expected) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}
