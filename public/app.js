import {
  authHash, parseRepo, bucketPr, repoStats, prSearchQuery, relTime,
} from "./lib.js";

// Existing worker — owns accounts, sessions and the synced settings blob.
// Nothing new was deployed for auth; this page is only a client of it.
const AUTH = "https://open-api-worker.sumanreddy568.workers.dev";
const SOURCE = "github-ops";
const GH = "https://api.github.com";

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("gho.token") || null, // auth-worker session token
  email: localStorage.getItem("gho.email") || null,
  pat: null,          // GitHub PAT, loaded from /settings
  login: null,        // GitHub username
  repos: [],          // [{full, selected}]
  found: [],          // repo names from search, for autocomplete only
  prs: [],            // search/issues items + _repo
};

// ── auth worker ─────────────────────────────────────────────────────────────
async function authApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${AUTH}${path}?source=${SOURCE}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify({ source: SOURCE, ...body }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const loadSettings = () => authApi("/settings").then((r) => r.data || {});
const saveSettings = (data) => authApi("/settings", { method: "PUT", body: { data } });

// ── github ──────────────────────────────────────────────────────────────────
async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : GH + path, {
    method,
    headers: {
      Authorization: `Bearer ${state.pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Search has its own 30/min bucket, separate from the 5000/hr core budget —
  // label which one this number came from or it reads as a scare.
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    const bucket = path.includes("/search/") ? "search/min" : "core/hr";
    $("rate").textContent = `${remaining} ${bucket} left`;
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `GitHub ${res.status}`, { cause: res.status });
  }
  return { data, link: res.headers.get("link") || "" };
}

// ponytail: 5-page cap (500 repos). Anyone past that adds repos by name instead.
async function ghPaged(path, cap = 5) {
  let url = path, out = [], pages = 0;
  while (url && pages++ < cap) {
    const { data, link } = await gh(url);
    out = out.concat(data);
    url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || null;
  }
  if (url) console.warn(`repo list truncated at ${cap} pages`);
  return out;
}

// ── login ───────────────────────────────────────────────────────────────────
async function doAuth(kind) {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("loginErr").textContent = "";
  if (!email || !password) return ($("loginErr").textContent = "Email and password required");
  try {
    const hash = await authHash(email, password);
    if (kind === "signup") {
      await authApi("/signup", { method: "POST", body: { hash, email } });
    }
    const { token } = await authApi("/login", { method: "POST", body: { hash } });
    state.token = token;
    state.email = email;
    localStorage.setItem("gho.token", token);
    localStorage.setItem("gho.email", email);
    await boot();
  } catch (e) {
    $("loginErr").textContent = e.message;
  }
}

function logout() {
  localStorage.removeItem("gho.token");
  localStorage.removeItem("gho.email");
  location.reload();
}

// ── repos ───────────────────────────────────────────────────────────────────
const shownRepos = () => {
  const needle = $("repoFilter").value.trim().toLowerCase();
  return state.repos.filter((r) => !needle || r.full.toLowerCase().includes(needle));
};

function renderRepos() {
  const shown = shownRepos();
  $("repoList").replaceChildren(
    ...shown.map((r) => {
      const el = document.createElement("span");
      el.className = "chip" + (r.selected ? " on" : "");
      el.textContent = r.full;
      el.onclick = () => { r.selected = !r.selected; renderRepos(); persistRepos(); };
      return el;
    }),
  );
  $("repoCount").textContent = `${shown.length}/${state.repos.length} shown · ${selected().length} selected`;
  renderSuggest();
  // Seed the ops pickers with a selected repo, but never overwrite typing.
  const first = selected()[0] || "";
  for (const el of [$("opsRepo"), $("prMergeRepo")]) if (!el.value) el.value = first;
}

// Suggestions = repos you have + anything the search turned up.
function renderSuggest() {
  const all = [...new Set([...state.repos.map((r) => r.full), ...state.found])];
  $("repoSuggest").replaceChildren(...all.map((f) => new Option(f, f)));
}

// Discovery only — the local list already covers loaded repos and filters with
// zero requests. This finds repos you haven't loaded, so it fires late and only
// on 3+ chars (search shares a 30/min bucket with the PR queries).
async function searchRepos(q) {
  if (!state.pat) return;
  const { data } = await gh(`/search/repositories?q=${encodeURIComponent(q)}&per_page=20`);
  const known = new Set(state.repos.map((r) => r.full));
  const extra = (data.items || []).map((i) => i.full_name).filter((f) => !known.has(f));
  if (!extra.length) return;
  state.found = [...new Set([...state.found, ...extra])].slice(-100);
  renderSuggest();
}

// Ops inputs accept free text, so validate before any write reaches GitHub.
function opsRepo(inputId, msgId) {
  const p = parseRepo($(inputId).value);
  if (!p) {
    $(msgId).textContent = "enter the repo as owner/name";
    return null;
  }
  return p.full;
}

const selected = () => state.repos.filter((r) => r.selected).map((r) => r.full);

function persistRepos() {
  saveSettings({ githubToken: state.pat || "", repos: selected() }).catch(() => {});
}

function addRepo(input) {
  const p = parseRepo(input);
  if (!p) return false;
  if (!state.repos.some((r) => r.full === p.full)) state.repos.push({ full: p.full, selected: true });
  else state.repos.find((r) => r.full === p.full).selected = true;
  renderRepos();
  persistRepos();
  return true;
}

async function fetchMyRepos() {
  $("prMsg").textContent = "loading repos…";
  const list = await ghPaged(
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  );
  const known = new Set(state.repos.map((r) => r.full));
  for (const r of list) if (!known.has(r.full_name)) state.repos.push({ full: r.full_name, selected: false });
  renderRepos();
  $("prMsg").textContent = `${list.length} repos available — pick some`;
}

// ── PRs ─────────────────────────────────────────────────────────────────────
async function loadPrs() {
  const repos = selected();
  if (!repos.length) return ($("prMsg").textContent = "select at least one repo");
  const st = $("prState").value;
  $("prMsg").textContent = "searching…";
  // One search per repo, in parallel: `search/issues` ORs repeated qualifiers
  // inconsistently and caps query length, and per-repo results give the stats
  // grouping for free. Search is rate-limited at 30/min, so a handful is fine.
  const results = await Promise.all(
    repos.map(async (full) => {
      const q = encodeURIComponent(prSearchQuery(state.login, full, st));
      const { data } = await gh(`/search/issues?q=${q}&per_page=100&sort=updated`);
      return (data.items || []).map((it) => ({ ...it, _repo: full }));
    }),
  );
  state.prs = results.flat().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  $("prMsg").textContent = `${state.prs.length} PRs`;
  renderPrs();
  renderStats();
}

function renderPrs() {
  const needle = $("prFilter").value.toLowerCase();
  const rows = state.prs
    .filter((p) => !needle || p.title.toLowerCase().includes(needle) || p._repo.toLowerCase().includes(needle))
    .map((p) => {
      const b = bucketPr(p);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="dim mono" style="font-size:12px">${escapeHtml(p._repo)}</td>
        <td class="mono">${Number(p.number)}</td>
        <td><a href="${escapeHtml(p.html_url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></td>
        <td><span class="badge b-${b}">${b}</span>${p.draft ? ' <span class="badge b-draft">draft</span>' : ""}</td>
        <td class="dim">${relTime(p.created_at)}</td>
        <td class="dim">${relTime(p.updated_at)}</td>`;
      return tr;
    });
  $("prRows").replaceChildren(...rows);
}

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── stats ───────────────────────────────────────────────────────────────────
function renderStats() {
  const groups = new Map([["ALL SELECTED REPOS", state.prs]]);
  for (const p of state.prs) {
    if (!groups.has(p._repo)) groups.set(p._repo, []);
    groups.get(p._repo).push(p);
  }
  $("statCards").replaceChildren(
    ...[...groups].map(([name, items]) => {
      const s = repoStats(items);
      const pct = (n) => (s.total ? (n / s.total) * 100 : 0);
      const card = document.createElement("div");
      card.className = "panel";
      card.innerHTML = `
        <div class="dim mono" style="font-size:12px">${escapeHtml(name)}</div>
        <div class="stat">${s.total} <span class="dim" style="font-size:13px">PRs</span></div>
        <div class="bar">
          <div style="width:${pct(s.merged)}%;background:var(--purple)"></div>
          <div style="width:${pct(s.open)}%;background:var(--green)"></div>
          <div style="width:${pct(s.closed)}%;background:var(--red)"></div>
        </div>
        <div class="kv"><span class="dim">merged</span><b>${s.merged}</b></div>
        <div class="kv"><span class="dim">open</span><b>${s.open}${s.draft ? ` (${s.draft} draft)` : ""}</b></div>
        <div class="kv"><span class="dim">closed unmerged</span><b>${s.closed}</b></div>
        <div class="kv"><span class="dim">median time to merge</span><b>${
          s.medianMergeHours === null ? "—" : fmtHours(s.medianMergeHours)
        }</b></div>
        <div class="kv"><span class="dim">oldest open</span><b>${
          s.oldestOpenDays === null ? "—" : s.oldestOpenDays + "d"
        }</b></div>`;
      return card;
    }),
  );
}

const fmtHours = (h) => (h < 48 ? `${h}h` : `${(h / 24).toFixed(1)}d`);

// ── ops ─────────────────────────────────────────────────────────────────────
const BRANCH_PAGES = 10; // 1000 branches of autocomplete; typing covers the rest

async function loadBranches() {
  const repo = opsRepo("opsRepo", "opsMsg");
  if (!repo) return;
  $("opsMsg").textContent = "loading branches…";
  const list = await ghPaged(`/repos/${repo}/branches?per_page=100`, BRANCH_PAGES);
  const names = list.map((b) => b.name);
  $("branchList").replaceChildren(...names.map((n) => new Option(n, n)));
  const capped = names.length >= BRANCH_PAGES * 100;
  $("opsMsg").textContent = `${names.length} branches for autocomplete${
    capped ? " (GitHub returns these alphabetically and this is the cap — just type any branch name, it doesn't have to be in the list)" : ""
  }`;
}

async function compare() {
  const repo = opsRepo("opsRepo", "opsMsg");
  const head = $("opsHead").value.trim(), base = $("opsBase").value.trim();
  if (!repo || !head || !base) return ($("opsMsg").textContent ||= "type both branches");
  $("opsMsg").textContent = "comparing…";
  const { data } = await gh(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  $("opsMsg").textContent =
    `${head} is ${data.ahead_by} ahead / ${data.behind_by} behind ${base}\n` +
    `${data.total_commits} commits, ${data.files?.length ?? "?"} files changed — status: ${data.status}`;
}

async function mergeBranch() {
  const repo = opsRepo("opsRepo", "opsMsg");
  const head = $("opsHead").value.trim(), base = $("opsBase").value.trim();
  if (!repo || !head || !base) return ($("opsMsg").textContent ||= "type both branches");
  if (head === base) return ($("opsMsg").textContent = "head and base are the same branch");
  if (!confirm(`Merge ${head} INTO ${base} on ${repo}?\n\nThis writes to GitHub immediately.`)) return;
  $("opsMsg").textContent = "merging…";
  try {
    const { data } = await gh(`/repos/${repo}/merges`, {
      method: "POST",
      body: { base, head, commit_message: `Merge ${head} into ${base} (github-ops)` },
    });
    $("opsMsg").textContent = data.sha
      ? `merged — ${data.sha.slice(0, 8)}\n${data.html_url || ""}`
      : "already up to date, nothing to merge";
  } catch (e) {
    // 409 from /merges means merge conflict — GitHub will not auto-resolve.
    $("opsMsg").textContent = `failed: ${e.message}`;
  }
}

async function mergePr() {
  const repo = opsRepo("prMergeRepo", "prMergeMsg");
  const num = $("prMergeNum").value, method = $("prMergeMethod").value;
  if (!repo || !num) return ($("prMergeMsg").textContent ||= "enter a PR number");
  if (!confirm(`${method} PR #${num} on ${repo}?\n\nThis writes to GitHub immediately.`)) return;
  $("prMergeMsg").textContent = "merging…";
  try {
    const { data } = await gh(`/repos/${repo}/pulls/${num}/merge`, {
      method: "PUT",
      body: { merge_method: method },
    });
    $("prMergeMsg").textContent = `${data.message || "merged"} ${data.sha ? data.sha.slice(0, 8) : ""}`;
  } catch (e) {
    $("prMergeMsg").textContent = `failed: ${e.message}`;
  }
}

// ── boot / wiring ───────────────────────────────────────────────────────────
async function boot() {
  if (!state.token) return;
  let settings;
  try {
    settings = await loadSettings();
  } catch (e) {
    // Only a rejected session should drop the stored token; a network blip
    // must not silently log the user out.
    if (e.status === 401) return logout();
    $("loginErr").textContent = e.message;
    return;
  }
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("whoami").textContent = state.email || "";
  state.repos = (settings.repos || []).map((full) => ({ full, selected: true }));
  renderRepos();
  if (settings.githubToken) {
    await usePat(settings.githubToken);
  } else {
    $("patStatus").textContent = "— add your GitHub token to start";
    $("settings").open = true;
  }
}

async function usePat(pat) {
  state.pat = pat;
  try {
    const { data } = await gh("/user");
    state.login = data.login;
    $("patMsg").innerHTML = `<span class="ok">✓ ${escapeHtml(data.login)}</span> — token active`;
    $("patStatus").textContent = `— token active (${data.login})`;
    $("pat").value = "";
    $("pat").placeholder = "stored ✓ — paste a new one to replace";
  } catch (e) {
    state.pat = null;
    $("patMsg").innerHTML = `<span class="err">token rejected: ${escapeHtml(e.message)}</span>`;
    $("patStatus").textContent = "— token rejected, update it";
    $("settings").open = true; // a dead token is the one thing worth interrupting for
  }
}

$("loginBtn").onclick = () => doAuth("login");
$("signupBtn").onclick = () => doAuth("signup");
// Block body, not `e.key === "Enter" && …`: an on* handler that returns false
// cancels the event's default action, which swallows every non-Enter keystroke
// and makes the field look broken.
$("password").onkeydown = (e) => { if (e.key === "Enter") doAuth("login"); };
$("email").onkeydown = (e) => { if (e.key === "Enter") $("password").focus(); };
$("logoutBtn").onclick = logout;

$("patSave").onclick = async () => {
  const pat = $("pat").value.trim();
  if (!pat) return;
  await usePat(pat);
  if (state.pat) {
    await saveSettings({ githubToken: pat, repos: selected() });
    $("settings").open = false; // done here — get out of the way
  }
};
$("patClear").onclick = async () => {
  state.pat = state.login = null;
  await saveSettings({ githubToken: "", repos: selected() });
  $("patMsg").textContent = "token cleared";
  $("patStatus").textContent = "— no token";
  $("pat").placeholder = "ghp_… / github_pat_…";
};

$("repoAddBtn").onclick = () => { if (addRepo($("repoAdd").value)) $("repoAdd").value = ""; };
$("repoAdd").onkeydown = (e) => { if (e.key === "Enter") $("repoAddBtn").onclick(); };
$("repoFetch").onclick = () => fetchMyRepos().catch((e) => ($("prMsg").textContent = e.message));
$("repoFilter").oninput = renderRepos;
// "Select all" honours the filter — otherwise filtering then clicking it would
// silently select every repo you've ever loaded.
$("repoSelAll").onclick = () => { shownRepos().forEach((r) => (r.selected = true)); renderRepos(); persistRepos(); };
$("repoSelNone").onclick = () => { state.repos.forEach((r) => (r.selected = false)); renderRepos(); persistRepos(); };

let searchTimer;
$("repoAdd").oninput = () => {
  clearTimeout(searchTimer);
  const q = $("repoAdd").value.trim();
  if (q.length < 3 || parseRepo(q)) return; // exact owner/repo needs no search
  searchTimer = setTimeout(() => searchRepos(q).catch(() => {}), 400);
};

$("prLoad").onclick = () => loadPrs().catch((e) => ($("prMsg").textContent = e.message));
$("prFilter").oninput = renderPrs;
$("prState").onchange = () => loadPrs().catch((e) => ($("prMsg").textContent = e.message));

$("opsBranches").onclick = () => loadBranches().catch((e) => ($("opsMsg").textContent = e.message));
// Editing the repo must not leave the previous repo's branches in the datalist.
$("opsRepo").oninput = () => {
  $("branchList").replaceChildren();
  $("opsMsg").textContent = "";
};
$("opsCompare").onclick = () => compare().catch((e) => ($("opsMsg").textContent = e.message));
$("opsMerge").onclick = mergeBranch;
$("prMergeBtn").onclick = mergePr;

for (const btn of document.querySelectorAll("nav.tabs button")) {
  btn.onclick = () => {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("on", b === btn));
    for (const t of ["prs", "stats", "ops"]) $(`tab-${t}`).classList.toggle("hidden", t !== btn.dataset.tab);
  };
}

boot();
