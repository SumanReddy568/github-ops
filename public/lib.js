// Pure helpers. No DOM, no network — so test.mjs can import them in node.

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same derivation the auth worker's other clients use (locator_spy, speed100):
// the server only ever stores this hash, never the password.
export const authHash = (email, password) =>
  sha256Hex(`${email.toLowerCase()}:${password}`);

export function parseRepo(s) {
  const cleaned = String(s || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` } : null;
}

// search/issues returns *issues*, so a PR's real state is split across two
// fields: state is open|closed, and pull_request.merged_at is set only when it
// actually merged. Closed-unmerged and merged both report state "closed".
export function bucketPr(item) {
  if (item.state === "open") return "open";
  return item.pull_request?.merged_at ? "merged" : "closed";
}

export function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// `now` is a parameter so the test is deterministic.
export function repoStats(items, now = Date.now()) {
  const s = {
    total: items.length,
    open: 0,
    merged: 0,
    closed: 0,
    draft: 0,
    medianMergeHours: null,
    oldestOpenDays: null,
  };
  const mergeHours = [];
  let oldestOpen = null;
  for (const it of items) {
    const b = bucketPr(it);
    s[b]++;
    if (it.draft) s.draft++;
    if (b === "merged") {
      mergeHours.push(
        (Date.parse(it.pull_request.merged_at) - Date.parse(it.created_at)) / HOUR,
      );
    }
    if (b === "open") {
      const t = Date.parse(it.created_at);
      if (oldestOpen === null || t < oldestOpen) oldestOpen = t;
    }
  }
  const m = median(mergeHours);
  s.medianMergeHours = m === null ? null : Math.round(m * 10) / 10;
  s.oldestOpenDays = oldestOpen === null ? null : Math.floor((now - oldestOpen) / DAY);
  return s;
}

export function prSearchQuery(login, repoFull, state = "all") {
  const parts = ["is:pr", `author:${login}`, `repo:${repoFull}`];
  if (state === "open") parts.push("is:open");
  if (state === "merged") parts.push("is:merged");
  if (state === "closed") parts.push("is:closed", "is:unmerged");
  return parts.join(" ");
}

export function relTime(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
