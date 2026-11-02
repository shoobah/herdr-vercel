// Your Vercel deployments in a popup, as the Sentry mod shows Sentry's
// issues: the recent ones, production, previews and the failed ones, for one
// project or all of them. Open one for its URL, aliases, commit, pull request
// and the tail of its build log; open it, redeploy it, promote it, cancel a
// build; and one key to start an agent on a failed build, in a tab of the
// space where its repo is.
//
// The work is Vercel's REST API, through curl on this computer. The token is
// the Vercel CLI's: VERCEL_TOKEN, else the token in the CLI's auth.json
// (`vercel login` writes it). That token expires after some hours; when it
// has, the helper runs `vercel whoami`, which makes the CLI renew it. The
// team comes from the shown space's repo (.vercel/project.json), else
// VERCEL_ORG_ID, else the CLI's current team, else the first team.
// The token never reaches this script: the shell reads it and hands it to
// curl on stdin.

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { agents, panes, spaces, run, exec, theme, appHome, props, closeOverlay, openOverlay, nextCommand, knownAgents } from "herdr";
import { tones, tint, countPill, stateColor, STATE_WORDS, icon, chip, key, ago, duration, MONO } from "./look.js";
import { demoApi, DEMO_TEAM, DEMO_PROJECTS } from "./demo.js";

// One call to Vercel. `conf` prints whether there is a token and the CLI's
// current team, a line each; `refresh` makes the CLI renew its token. Any
// other mode is an HTTP method: the body, then the status code on a line of
// its own.
const VERCEL = String.raw`
dirs="${"${"}XDG_DATA_HOME:-$HOME/.local/share}/com.vercel.cli
$HOME/Library/Application Support/com.vercel.cli
$HOME/.local/share/com.vercel.cli"
num() { sed -n "s/.*\"$2\"[ ]*:[ ]*\([0-9][0-9]*\).*/\1/p" "$1" | head -n 1; }
str() { sed -n "s/.*\"$2\"[ ]*:[ ]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; }
# The CLI's auth.json that lasts longest: the one it last renewed.
pick() {
  auth=; exp=0
  while IFS= read -r d; do
    f="$d/auth.json"
    [ -f "$f" ] || continue
    [ -n "$(str "$f" token)" ] || continue
    e=$(num "$f" expiresAt); e=${"${"}e:-9999999999}
    [ ${"${"}#e} -gt 11 ] && e=$((e / 1000))
    [ "$e" -gt "$exp" ] && { auth=$f; exp=$e; }
  done <<EOF
$dirs
EOF
}
renew() {
  if command -v vercel >/dev/null 2>&1; then vercel whoami >/dev/null 2>&1 </dev/null
  else "${"${"}SHELL:-/bin/zsh}" -lic 'vercel whoami' >/dev/null 2>&1 </dev/null; fi
  pick
}
token() {
  [ -n "$VERCEL_TOKEN" ] && { printf '%s' "$VERCEL_TOKEN"; return; }
  pick
  [ -n "$auth" ] && [ "$exp" -lt $(( $(date +%s) + 60 )) ] && renew
  [ -n "$auth" ] && str "$auth" token
}
if [ "$1" = conf ]; then
  team=$VERCEL_ORG_ID
  if [ -z "$team" ]; then
    while IFS= read -r d; do
      [ -f "$d/config.json" ] && team=$(str "$d/config.json" currentTeam) && [ -n "$team" ] && break
    done <<EOF
$dirs
EOF
  fi
  printf '%s\n%s\n' "$([ -n "$(token)" ] && echo yes)" "$team"
  exit 0
fi
if [ "$1" = refresh ]; then [ -n "$VERCEL_TOKEN" ] || renew; exit 0; fi
tok=$(token)
[ -n "$tok" ] || { echo "No Vercel token." >&2; exit 64; }
if [ -n "$3" ]; then
  printf 'Authorization: Bearer %s\n' "$tok" | curl -sS -m 25 -X "$1" -H @- -H 'Content-Type: application/json' --data-binary "$3" -w '\n%{http_code}' "https://api.vercel.com$2"
else
  printf 'Authorization: Bearer %s\n' "$tok" | curl -sS -m 25 -X "$1" -H @- -w '\n%{http_code}' "https://api.vercel.com$2"
fi
`;

// The helper's exit code when it finds no token (not one of curl's).
const NO_TOKEN = 64;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.signedOut = status === 401 || status === NO_TOKEN;
  }
}

async function call(method, path, body) {
  const r = await exec("sh", ["-c", VERCEL, "sh", method, path, body ? JSON.stringify(body) : ""]);
  if (r.code === NO_TOKEN) throw new ApiError("No Vercel token.", NO_TOKEN);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `curl: exit ${r.code}`);
  const cut = r.stdout.lastIndexOf("\n");
  const status = Number(r.stdout.slice(cut + 1));
  const text = r.stdout.slice(0, cut);
  let res = null;
  try {
    res = text ? JSON.parse(text) : null;
  } catch {}
  return { status, res };
}

// A call, once more after the CLI renews its token if Vercel refuses it (a
// token can be withdrawn before the time auth.json gives).
async function vercel(method, path, body) {
  let { status, res } = await call(method, path, body);
  if (status === 401 || (status === 403 && res?.error?.invalidToken)) {
    await exec("sh", ["-c", VERCEL, "sh", "refresh"]);
    ({ status, res } = await call(method, path, body));
  }
  if (status >= 400 || !status) {
    const why = res?.error?.message ?? "";
    const out = status === 401 || res?.error?.invalidToken;
    throw new ApiError(out ? "Vercel refused the token." : `Vercel: ${status} ${why}`.trim(), out ? 401 : status);
  }
  return res;
}

async function conf() {
  const r = await exec("sh", ["-c", VERCEL, "sh", "conf"]);
  const [token, team] = r.stdout.split("\n");
  return { token: token === "yes", team: team || null };
}

const TABS = [
  { id: "recent", label: "Recent", short: "All", icon: "calendar", query: {} },
  { id: "production", label: "Production", short: "Prod", icon: "server", query: { target: "production" } },
  { id: "preview", label: "Previews", short: "Prev", icon: "branch", query: { target: "preview" } },
  { id: "failed", label: "Failed", short: "Failed", icon: "cross", query: { state: "ERROR" } },
];

// What can be looked up in the whole team when typed or pasted in the
// filter: a deployment's id, or its URL or an alias.
const LOOKUP = /^(dpl_[A-Za-z0-9]+|(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?)$/i;
// A pull request's preview alias: app-pr-1234-team.vercel.app.
const PR_ALIAS = /-pr-(\d+)-/;
// Where the lists are kept between openings.
const CACHE = `${appHome()}/vercel-cache.json`;
const ALL = "";

const HEADING_H = 30;
const ROW_H = 36;
const LIST_H = 560;
const LOG_LINES = 80;

const BUSY = new Set(["BUILDING", "INITIALIZING", "QUEUED"]);

// What an agent is told when you start one on a failed build.
const PROMPT = (d, err) =>
  `The Vercel deployment https://${d.url} (${d.target ?? "preview"}${d.branch ? `, branch ${d.branch}` : ""}${d.sha ? `, commit ${d.sha.slice(0, 7)}` : ""}) failed` +
  `${err ? `: ${err}` : "."}\n${d.inspectorUrl}\n\n` +
  `Read its build log (\`vercel inspect --logs ${d.url}\`), find the cause in this repo and fix it test-first. ` +
  `Tell me if it is not caused by our code.`;

const DONE = { Redeploying: "Redeploy started for", Promoting: "Promoted", Canceling: "Canceled" };

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

const qs = (q) => Object.entries(q).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const stripAnsi = (s) => String(s ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

export default class Vercel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.backTo = p.backTo ?? null;
    this.demo = Boolean(p.demo);
    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "recent";
    if (!TABS.some((t) => t.id === this.tab)) this.tab = "recent";
    this.project = localStorage.getItem("project");
    this.lists = {};
    this.found = null;
    this.filter = "";
    this.at = 0;
    this.cur = null;
    this.detail = null;
    this.menu = null;
    this.flash = this.err = this.busy = "";
    this.projects = [];
    // Each project's current production deployment, by id.
    this.current = new Set();
    this.width = 900;
    this.loadedAt = 0;
    this.hasGithub = false;
    cx.spawn(async (cx) => {
      this.hasGithub = (await fs.readFile(`${appHome()}/mods/github/main.js`, "utf8").catch(() => null)) !== null;
      cx.notify();
    });

    this.keys = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type to filter, or paste a deployment URL or id…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.lookUp(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (this.screen === "list" && !this.signedOut && !this.closing) this.input.focus();
      });
    });
    this.input.focus();
    cx.timer.after(400, () => this.screen === "list" && this.input.focus());

    cx.spawn(async (cx) => {
      await this.readCache(cx);
      await this.start(cx);
      if (p.deployment) await this.openById(p.deployment, cx);
      cx.notify();
    });
    // Every 10 s while something builds (the list, or the one shown), else
    // every minute.
    cx.timer.every(10000, (cx) => {
      if (this.busy || this.signedOut || !this.team) return;
      if (this.screen === "deployment") {
        if (BUSY.has(this.cur?.state)) this.loadDetail(cx);
        return;
      }
      const building = Object.values(this.lists).some((l) => l?.items?.some((d) => BUSY.has(d.state)));
      if (building || Date.now() - this.loadedAt > 60000) this.loadAll(cx);
    });

    // Key bindings and `herdr-app do`: vercel.escape, vercel.next,
    // vercel.prev, vercel.reload, vercel.demo.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        else if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (c === "reload") this.reload(cx);
        else if (c === "demo") {
          this.demo = !this.demo;
          this.lists = {};
          this.found = null;
          this.project = this.demo ? null : localStorage.getItem("project");
          this.screen = "list";
          await this.start(cx);
        }
        cx.notify();
      }
    });
  }

  // ── Vercel ─────────────────────────────────────────────────────────────

  api(method, path, body) {
    const team = this.team ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(this.team)}` : "";
    if (this.demo) return Promise.resolve().then(() => demoApi(method, path, body));
    return vercel(method, path + team, body);
  }

  // The repo of the space shown: its Vercel link (.vercel/project.json) and
  // its folder's name.
  async here() {
    const s = spaces().find((s) => s.active);
    const dir = s ? place(s) : null;
    if (!dir || s.machine) return { name: null, link: null };
    const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(() => null))?.stdout?.trim() || dir;
    const link = await fs.readFile(`${top}/.vercel/project.json`, "utf8").then(JSON.parse).catch(() => null);
    return { name: top.split("/").pop(), link };
  }

  // The team and its projects; the project shown is the one you chose last,
  // else the one the shown space's repo is linked to, else all of them.
  async start(cx) {
    this.err = "";
    this.signedOut = false;
    if (this.demo) {
      this.team = DEMO_TEAM.id;
      this.teamSlug = DEMO_TEAM.slug;
      this.projects = DEMO_PROJECTS;
      this.project ??= DEMO_PROJECTS[0].id;
      this.loadAll(cx);
      return;
    }
    try {
      const [c, here] = await Promise.all([conf(), this.here()]);
      if (!c.token) throw new ApiError("No Vercel token.", NO_TOKEN);
      this.team = here.link?.orgId ?? c.team;
      if (!this.team) {
        const teams = await vercel("GET", "/v2/teams?limit=20");
        this.team = teams?.teams?.[0]?.id ?? null;
      }
      const [ps, team] = await Promise.all([
        this.api("GET", "/v9/projects?limit=100"),
        this.team?.startsWith("team_") ? this.api("GET", `/v2/teams/${this.team}`).catch(() => null) : null,
      ]);
      if (this.demo) return;
      this.teamSlug = team?.slug ?? null;
      this.projects = (ps?.projects ?? []).map((p) => ({ id: p.id, slug: p.name })).sort((a, b) => a.slug.localeCompare(b.slug));
      this.keepCurrent(ps);
      if (this.project == null) {
        const p = this.projects.find((p) => p.id === here.link?.projectId) ?? this.projects.find((p) => p.slug === here.name);
        this.project = p?.id ?? (this.projects.length === 1 ? this.projects[0].id : ALL);
      }
      if (this.project !== ALL && !this.projects.some((p) => p.id === this.project)) this.project = ALL;
    } catch (e) {
      this.signedOut = Boolean(e?.signedOut);
      this.err = this.signedOut ? "" : String(e?.message ?? e);
      if (this.signedOut) this.keys.focus();
      return cx.notify();
    }
    this.seedAll();
    this.loadAll(cx);
  }

  // Signs in in a terminal of its own: the CLI's login, which opens Vercel
  // in the browser and keeps the token where the CLI keeps it.
  signIn() {
    this.dismiss();
    run("space.new", { name: "Vercel sign-in", argv: ["vercel", "login"] });
  }

  projectName(id = this.project) {
    return this.projects.find((p) => p.id === id)?.slug ?? (id ? "" : "All projects");
  }

  // The next project: all of them, then each in turn.
  switchProject(cx) {
    if (!this.projects.length) return;
    const order = [ALL, ...this.projects.map((p) => p.id)];
    this.project = order[(order.indexOf(this.project) + 1) % order.length];
    localStorage.setItem("project", this.project);
    this.lists = {};
    this.found = null;
    this.at = 0;
    this.seedAll();
    this.loadAll(cx);
    cx.notify();
  }

  // ── lists ──────────────────────────────────────────────────────────────

  loadAll(cx) {
    this.loadedAt = Date.now();
    for (const t of TABS) this.load(t.id, cx);
    this.loadCurrent(cx);
  }

  keepCurrent(ps) {
    this.current = new Set((ps?.projects ?? []).map((p) => p.targets?.production?.id).filter(Boolean));
  }

  // Which deployments are live now: a promote or a rollback changes it.
  loadCurrent(cx) {
    if (!this.team || this.loadingCurrent) return;
    this.loadingCurrent = true;
    cx.spawn(async (cx) => {
      try {
        this.keepCurrent(await this.api("GET", "/v9/projects?limit=100"));
      } catch {}
      this.loadingCurrent = false;
      cx.notify();
    });
  }

  async readCache(cx) {
    if (this.demo) return;
    this.cache = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
    this.seedAll();
    cx.notify();
  }

  seedAll() {
    const kept = this.cache?.lists?.[this.project ?? ALL];
    if (!kept || this.demo) return;
    for (const t of TABS) {
      const l = this.lists[t.id];
      if (kept[t.id] && !(l?.loaded && !l.cached)) this.lists[t.id] = { ...l, items: kept[t.id], loaded: true, cached: true, loading: l?.loading };
    }
  }

  keep(tab, items) {
    if (this.demo) return;
    const c = (this.cache ??= {});
    ((c.lists ??= {})[this.project ?? ALL] ??= {})[tab] = items;
    fs.writeFile(CACHE, JSON.stringify(c)).catch(() => {});
  }

  load(tab, cx) {
    const l = (this.lists[tab] ??= { items: [], loaded: false });
    if (l.loading || !this.team) return;
    l.loading = true;
    cx.notify();
    const project = this.project;
    cx.spawn(async (cx) => {
      try {
        const q = { limit: 60, projectId: project || null, ...TABS.find((t) => t.id === tab).query };
        const res = await this.api("GET", `/v6/deployments?${qs(q)}`);
        if (project !== this.project) return;
        l.items = (res?.deployments ?? []).map(slim);
        l.error = "";
        l.cached = false;
        this.keep(tab, l.items);
      } catch (e) {
        if (e?.signedOut) this.signedOut = true;
        l.error = String(e?.message ?? e);
      }
      l.loading = false;
      l.loaded = true;
      cx.notify();
    });
  }

  reload(cx) {
    if (this.screen === "deployment") return this.loadDetail(cx);
    this.loadAll(cx);
  }

  // A deployment id or URL in the filter: looked up across the team,
  // shortly after you stop typing.
  lookUp(cx) {
    const q = this.filter.trim();
    if (!LOOKUP.test(q)) {
      this.found = null;
      return;
    }
    cx.timer.after(300, (cx) => {
      if (this.filter.trim() !== q) return;
      cx.spawn(async (cx) => {
        try {
          const id = q.replace(/^https?:\/\//, "").replace(/\/$/, "");
          const res = await this.api("GET", `/v13/deployments/${encodeURIComponent(id)}`);
          if (this.filter.trim() === q && res?.id) this.found = { query: q, items: [slim(res)] };
        } catch {}
        cx.notify();
      });
    });
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
    localStorage.setItem("tab", this.tab);
    this.at = 0;
    cx.notify();
  }

  matches(x) {
    const hay = [x.url, x.name, x.branch, x.message, x.author, x.sha?.slice(0, 7), x.target, STATE_WORDS[x.state], x.pr ? `#${x.pr}` : ""]
      .filter(Boolean).join(" ").toLowerCase();
    return this.filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // The rows shown, grouped by project when all of them are listed.
  shownRows() {
    const l = this.lists[this.tab];
    const all = !this.project;
    const looked = this.found && this.filter.trim() === this.found.query;
    const rows = (l?.items ?? []).filter((x) => looked ? this.found.items.some((f) => f.id === x.id) : this.matches(x))
      .map((x) => ({ dep: x, group: all ? x.name : null }));
    if (all) rows.sort((a, b) => a.group.localeCompare(b.group) || b.dep.created - a.dep.created);
    if (looked) {
      const listed = new Set(rows.map((r) => r.dep.id));
      for (const d of this.found.items) if (!listed.has(d.id)) rows.push({ dep: d, group: "Not in this list" });
    }
    return rows;
  }

  enter(cx) {
    const r = this.shown?.[this.at];
    if (r) this.openDeployment(r.dep, cx);
  }

  // ── a deployment ───────────────────────────────────────────────────────

  focusKeys(cx) {
    cx.timer.after(30, () => this.keys.focus());
  }

  openDeployment(d, cx, direct = false) {
    this.screen = "deployment";
    this.cur = d;
    this.detail = null;
    this.menu = null;
    this.err = this.flash = "";
    this.direct = direct;
    this.loadDetail(cx);
    this.focusKeys(cx);
    cx.notify();
  }

  // From another mod, or a key binding's props: a deployment by its id or URL.
  async openById(ref, cx) {
    try {
      const id = String(ref.id ?? ref.url ?? ref).replace(/^https?:\/\//, "").replace(/\/$/, "");
      this.openDeployment(slim(await this.api("GET", `/v13/deployments/${encodeURIComponent(id)}`)), cx, true);
    } catch (e) {
      this.say(String(e?.message ?? e), cx, true);
    }
  }

  // The deployment as it is now, its project's production deployment (to
  // tell the current one), and the end of its build log.
  loadDetail(cx) {
    const d = this.cur;
    cx.spawn(async (cx) => {
      try {
        const [full, project, events] = await Promise.all([
          this.api("GET", `/v13/deployments/${d.id}`),
          d.projectId ? this.api("GET", `/v9/projects/${d.projectId}`).catch(() => null) : null,
          this.api("GET", `/v3/deployments/${d.id}/events?builds=1&direction=backward&limit=${LOG_LINES * 3}`).catch(() => null),
        ]);
        if (this.cur?.id !== d.id) return;
        this.cur = slim(full);
        const lines = (Array.isArray(events) ? events : [])
          .filter((e) => e.type === "stdout" || e.type === "stderr" || e.type === "command")
          .map((e) => stripAnsi(e.text ?? e.payload?.text ?? "")).filter((t) => t.trim()).reverse().slice(-LOG_LINES);
        this.detail = {
          aliases: (full.alias ?? []).filter((a) => a !== full.url),
          error: full.errorMessage ?? null,
          current: project ? project.targets?.production?.id === full.id : this.current.has(full.id),
          log: lines,
        };
        this.replaceRow(this.cur);
        this.err = "";
      } catch (e) {
        this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  replaceRow(d) {
    for (const l of Object.values(this.lists)) {
      const i = l?.items?.findIndex((x) => x.id === d.id) ?? -1;
      if (i >= 0) l.items[i] = { ...l.items[i], ...d, pr: d.pr ?? l.items[i].pr };
    }
  }

  back(cx) {
    if (this.direct && this.backTo) {
      this.dismiss();
      return openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
    }
    this.direct = false;
    const id = this.cur?.id;
    this.screen = "list";
    this.menu = null;
    this.err = this.flash = "";
    const i = this.shownRows().findIndex((r) => r.dep.id === id);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  escape(cx) {
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    if (this.screen !== "list") return this.back(cx);
    this.dismiss();
  }

  dismiss() {
    this.closing = true;
    closeOverlay(props().overlay);
  }

  open(url, cx) {
    if (!url) return;
    if (!/^https?:/.test(url)) url = `https://${url}`;
    if (this.demo) return this.say(`Demo: would open ${url}`, cx);
    cx.open_url(url);
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.say(`Copied ${text}`, cx);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // ── changing it ────────────────────────────────────────────────────────

  act(d, doing, fn, cx) {
    this.busy = `${doing} ${short(d)}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      let made = null;
      try {
        made = await fn();
        this.say(`${DONE[doing] ?? doing} ${short(d)}.`, cx);
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
      this.busy = "";
      // A redeploy goes to the new deployment, to watch it build.
      if (made?.id && this.screen === "deployment") return this.openDeployment(slim(made), cx);
      if (this.screen === "deployment") this.loadDetail(cx);
      this.loadAll(cx);
    });
  }

  // A new build of the same source, for the same target.
  redeploy(d, cx) {
    this.act(d, "Redeploying", () => this.api("POST", "/v13/deployments?forceNew=1", {
      name: d.name, deploymentId: d.id, ...(d.target === "production" ? { target: "production" } : {}),
    }), cx);
  }

  // Points the project's production domains at it: a preview goes live, an
  // older production deployment is a rollback.
  promote(d, cx) {
    this.act(d, "Promoting", () => this.api("POST", `/v10/projects/${d.projectId}/promote/${d.id}`), cx);
  }

  cancel(d, cx) {
    this.act(d, "Canceling", () => this.api("PATCH", `/v12/deployments/${d.id}/cancel`), cx);
  }

  // What can be done with it, each after a choice in the menu (nothing that
  // changes Vercel runs on one key alone).
  actionsMenu(cx, d = this.cur) {
    if (!d) return;
    const items = [];
    if (BUSY.has(d.state)) items.push({ label: "Cancel the build", icon: "cross", run: (cx) => this.cancel(d, cx) });
    if (d.state === "READY" && d.projectId && !(this.screen === "deployment" && this.detail?.current)) {
      items.push({ label: d.target === "production" ? "Roll production back to it" : "Promote it to production", icon: "server", run: (cx) => this.promote(d, cx) });
    }
    if (!BUSY.has(d.state)) items.push({ label: `Redeploy (${d.target === "production" ? "production" : "preview"})`, icon: "play", run: (cx) => this.redeploy(d, cx) });
    if (!items.length) return this.say("Nothing to do with it now.", cx);
    this.menu = { title: `${short(d)} · ${this.projectName(d.projectId) || d.name}`, items, at: 0 };
    cx.notify();
  }

  // Its pull request: in the GitHub mod, esc there coming back here; else
  // in the browser.
  openPR(cx, d = this.cur) {
    if (!d?.pr) return this.say("No pull request for it.", cx);
    const repo = d.repo ?? null;
    if (!repo) return this.say(`PR #${d.pr}: no GitHub repo is known for it.`, cx);
    if (!this.hasGithub) return this.open(`https://github.com/${repo}/pull/${d.pr}`, cx);
    this.dismiss();
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.8, props: {
      pr: { host: "github.com", repo, number: Number(d.pr) }, demo: this.demo || undefined,
      backTo: { mod: "vercel", label: short(d), props: { deployment: { id: d.id }, demo: this.demo || undefined, backTo: this.backTo ?? undefined } },
    } });
  }

  dashboard(d) {
    return d?.inspectorUrl ?? (this.teamSlug ? `https://vercel.com/${this.teamSlug}/${d.name}/${d.id.replace(/^dpl_/, "")}` : null);
  }

  // ── an agent on it ─────────────────────────────────────────────────────

  // The space for a deployment's repo: one whose folder is named as the
  // repo or the project, else the one shown.
  spaceFor(d) {
    const names = [d.repo?.split("/")[1], d.name].filter(Boolean);
    const local = spaces().filter((s) => !s.machine);
    const inRepo = (s) => {
      const parts = (place(s) ?? "").split("/");
      return names.some((n) => parts.includes(n));
    };
    return local.find((s) => s.active && inRepo(s)) ?? local.find(inRepo) ?? spaces().find((s) => s.active) ?? null;
  }

  // The agents on a deployment: those in a tab named after its short id.
  agentsOf(d) {
    if (!d) return [];
    const s = short(d);
    return agents().filter((a) => a.tab_name?.includes(s) || a.title?.includes(s))
      .map((a) => ({ name: a.title || a.tab_name, status: a.status, address: a.address }));
  }

  // A tab named after the failed build, in its repo's space, with an agent
  // told to fix it. With an agent already on it, goes there instead.
  startAgent(cx, d = this.cur) {
    if (!d) return;
    const on = this.agentsOf(d)[0];
    if (on) {
      this.dismiss();
      return run("agent.focus", { terminal: on.address });
    }
    if (d.state !== "ERROR") return this.say("Only a failed build gets an agent.", cx);
    const s = this.spaceFor(d);
    if (!s) return this.say("No space to start it in.", cx, true);
    if (this.demo) return this.say(`Demo: would open a tab ${short(d)} in ${s.name} with an agent told to fix the build.`, cx);
    this.busy = "Finding the agent to start…";
    cx.notify();
    const err = this.cur?.id === d.id ? this.detail?.error : null;
    cx.spawn(async (cx) => {
      const known = await knownAgents({ on: s.machine }).catch(() => []);
      const agent = known.find((a) => a.installed && a.key === "claude") ?? known.find((a) => a.installed);
      this.busy = "";
      if (!agent) return this.say("No agent is installed to start.", cx, true);
      const spec = { space: s.id, name: `${short(d)} build`, argv: agent.run, task: PROMPT(d, err) };
      const folder = place(s);
      if (folder) spec.folder = folder;
      run("space.select", { id: s.id });
      run("tab.new", spec);
      this.dismiss();
    });
  }

  // ── keys ───────────────────────────────────────────────────────────────

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (/^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  choose(item, cx) {
    this.menu = null;
    item.run(cx);
    cx.notify();
  }

  depKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    const d = this.cur;
    switch (k) {
      case "left":
      case "backspace":
        this.back(cx);
        break;
      case "s":
        this.startAgent(cx);
        break;
      case "c":
        this.actionsMenu(cx);
        break;
      case "g":
        this.openPR(cx);
        break;
      case "o":
        this.open(d.url, cx);
        break;
      case "i":
        this.open(this.dashboard(d), cx);
        break;
      case "y":
        this.copy(`https://${d.url}`, cx);
        break;
      case "u":
        this.loadDetail(cx);
        break;
      default:
        return false;
    }
    return true;
  }

  listKey(k, cx) {
    if (this.signedOut) return false;
    const n = this.shown?.length ?? 0;
    const r = this.shown?.[this.at];
    if (k === "down" && n) (this.at = Math.min(n - 1, this.at + 1)), this.follow();
    else if (k === "up" && n) (this.at = Math.max(0, this.at - 1)), this.follow();
    else if (k === "pagedown" && n) (this.at = Math.min(n - 1, this.at + 12)), this.follow();
    else if (k === "pageup" && n) (this.at = Math.max(0, this.at - 12)), this.follow();
    else if (k === "right" && !this.filter) this.step(1, cx);
    else if (k === "left" && !this.filter) this.step(-1, cx);
    else if (k === "ctrl-s" && r) this.startAgent(cx, r.dep);
    else if (k === "ctrl-o" && r) this.open(r.dep.url, cx);
    else if (k === "ctrl-y" && r) this.copy(`https://${r.dep.url}`, cx);
    else if (k === "ctrl-t") this.switchProject(cx);
    else return false;
    return true;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  stateDot(o, d, size = 8) {
    const color = stateColor(o, d.state);
    return BUSY.has(d.state) && d.state !== "QUEUED" ? icon("work", color, size + 4).spin(1100) : div().flex_none().w(size).h(size).rounded_full().bg(color);
  }

  // A deployment's row, one line: its state, where it went, its branch and
  // commit message; then its agents, how long it built, when, and who.
  depCard(o, d, on) {
    const color = stateColor(o, d.state);
    const ag = this.agentsOf(d);
    const busy = ag.find((a) => a.status === "working");
    const wide = this.width >= 760;
    const prod = d.target === "production";
    const live = this.current.has(d.id);
    return h_flex()
      .id(`dp-${d.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on && !live, (el) => el.bg(o.raised).shadow_sm())
      .when(!on && !live, (el) => el.hover((el) => el.bg(o.raised)))
      .when(live, (el) => el.bg(tint(o.review, on ? 0.24 : 0.12)).when(on, (el) => el.shadow_sm()).when(!on, (el) => el.hover((el) => el.bg(tint(o.review, 0.18)))))
      .cursor_pointer()
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(color)))
      .child(div().flex_none().w(12).flex().items_center().justify_center().child(this.stateDot(o, d)))
      .child(div().flex_none().w(wide ? 74 : 40).text_size(11.5).font_medium().text_color(prod ? o.accent : o.dim).child(prod ? (wide ? "Production" : "Prod") : (wide ? "Preview" : "Prev")))
      .child(div().flex_none().w(wide ? 170 : 110).font_family(MONO).text_size(11.5).text_color(o.muted).truncate().child(d.branch ?? d.url.split(".")[0]))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_shrink(1).min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(d.state === "CANCELED" ? o.dim : o.fg).child(d.message || d.url))
        .when(Boolean(d.pr), (el) => el.child(div().flex_none().font_family(MONO).text_size(11.5).text_color(o.dim).child(`#${d.pr}`)))
        .when(live, (el) => el.child(chip(o, `cur-${d.id}`, ["Current"], { color: o.review }))))
      .when(ag.length > 0, (el) => el.child(busy
        ? h_flex().flex_none().gap(4).items_center().child(icon("work", o.work, 12).spin(1100)).child(div().text_size(12).text_color(o.work).child("agent"))
        : h_flex().flex_none().gap(4).items_center().child(icon("person", o.dim, 12)).child(div().text_size(12).text_color(o.dim).child("agent"))))
      .child(div().flex_none().w(44).text_size(12).font_family(MONO).text_color(d.state === "ERROR" ? o.fix : o.muted).child(built(d)))
      .child(div().flex_none().w(64).text_size(12).text_color(o.dim).child(ago(d.created)))
      .when(wide, (el) => el.child(div().flex_none().w(110).truncate().text_size(12).text_color(o.dim).child(d.author ?? "")));
  }

  heading(o, label, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(o.dim).child(label.toUpperCase()))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    let bar = h_flex().flex_none().gap(4).items_center().children(TABS.map((tb) => {
      const on = tb.id === this.tab;
      const l = this.lists[tb.id];
      return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
        .when(on, (el) => el.bg(o.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.tab = tb.id;
          localStorage.setItem("tab", tb.id);
          this.at = 0;
          cx.notify();
        })
        .child(l?.loading && !l.loaded ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
        .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(this.width < 700 ? tb.short : tb.label))
        .child(countPill(o, l?.loaded ? l.items.length : null, on));
    }));
    bar = bar.child(div().flex_1());
    // The project: a click (or ctrl+t) goes to the next, all of them first.
    if (this.team) {
      bar = bar.child(h_flex().id("proj").flex_none().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(o.line)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.switchProject(cx))
        .child(icon("project", o.dim, 12))
        .child(div().text_size(12).text_color(o.muted).child(this.projectName()))
        .when(Boolean(this.teamSlug), (el) => el.child(div().font_family(MONO).text_size(11).text_color(o.dim).child(this.teamSlug))));
    }
    return bar;
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  listBody(o) {
    const notes = [];
    const entries = [];
    this.entryOf = [];
    const l = this.lists[this.tab];
    const rows = this.shown;
    if (l?.error) notes.push(this.note(o, l.error, o.fix));
    else if (!rows.length) {
      const empty = this.err ? "" : !l?.loaded || l.loading ? "Loading…"
        : this.filter ? "Nothing matches. A deployment's URL or dpl_ id looks in the whole team."
        : this.tab === "failed" ? "No failed deployments." : "No deployments.";
      if (empty) notes.push(this.note(o, empty));
    }
    let last;
    rows.forEach((r, i) => {
      if (r.group && r.group !== last) {
        entries.push({ key: `h-${r.group}`, h: HEADING_H, el: () => this.heading(o, r.group, rows.filter((x) => x.group === r.group).length) });
      }
      last = r.group;
      this.entryOf[i] = entries.length;
      entries.push({ key: `r-${r.dep.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.depCard(o, r.dep, i === this.at)) });
    });
    return { notes, entries };
  }

  listView(o) {
    const { notes, entries } = this.listBody(o);
    return v_flex().flex_1().min_h(0).gap(2)
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("vc-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            }))
          .child(Scrollbar.vertical("vc-rows").absolute().inset_0())));
  }

  follow() {
    const e = this.entryOf?.[this.at];
    if (e == null) return;
    this.scroll.scroll_to_item(this.at === 0 ? 0 : e);
  }

  field(o, label, kids) {
    return h_flex().gap(10).items_center().min_h(24)
      .child(div().flex_none().w(72).text_size(12).text_color(o.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().items_center().children([kids].flat().filter(Boolean)));
  }

  backButton(o, label) {
    return h_flex().id("back").flex_none().h(24).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => this.back(cx))
      .child(icon("back", o.muted, 13))
      .child(div().text_size(12).text_color(o.muted).child(label));
  }

  fromLabel() {
    if (this.direct && this.backTo?.label) return this.backTo.label;
    const tb = TABS.find((x) => x.id === this.tab);
    return tb?.label ?? "Vercel";
  }

  // A deployment's screen.
  depView(o) {
    const d = this.cur;
    const x = this.detail;
    const color = stateColor(o, d.state);
    const ag = this.agentsOf(d);
    const txt = (s, c = o.fg) => div().text_color(c).child(s);
    const prod = d.target === "production";
    const log = x?.log?.length ? ["```", ...x.log, "```"].join("\n") : x ? "*No build output.*" : null;
    return v_flex().flex_1().min_h(0).gap(10)
      .child(
        h_flex().flex_none().gap(10).items_center()
          .child(this.backButton(o, this.fromLabel()))
          .child(chip(o, "state", [this.stateDot(o, d, 7), STATE_WORDS[d.state] ?? d.state], { color }))
          .child(chip(o, "target", [prod ? "Production" : "Preview"], { color: prod ? o.accent : null }))
          .when(Boolean(x?.current), (el) => el.child(chip(o, "current", ["Current"], { color: o.review })))
          .child(div().font_family(MONO).text_size(12.5).text_color(o.muted).child(short(d)))
          .child(div().text_size(12.5).text_color(o.dim).child(this.projectName(d.projectId) || d.name))
          .child(div().flex_1()),
      )
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).line_height(1.35).child(d.message || d.url))
      .child(this.field(o, "URL", chip(o, "url", [d.url], { mono: true, click: (cx) => this.open(d.url, cx) })))
      .when((x?.aliases ?? []).length > 0, (el) => el.child(this.field(o, "Aliases", x.aliases.slice(0, 4).map((a, i) =>
        chip(o, `al-${i}`, [a], { mono: true, click: (cx) => this.open(a, cx) })))))
      .when(Boolean(d.branch || d.sha), (el) => el.child(this.field(o, "Source", [
        d.branch ? chip(o, "branch", [icon("branch", o.dim, 12), d.branch], { mono: true }) : null,
        d.sha ? chip(o, "sha", [d.sha.slice(0, 7)], { mono: true, click: d.repo ? (cx) => this.open(`https://github.com/${d.repo}/commit/${d.sha}`, cx) : null }) : null,
        d.pr ? chip(o, "pr", [icon("pr", o.accent, 12), `#${d.pr}`], { color: o.accent, click: (cx) => this.openPR(cx) }) : null,
      ])))
      .child(this.field(o, "Built", [
        txt(built(d) || "–"), txt("·", o.dim), txt(`created ${ago(d.created)}`, o.muted),
        d.author ? txt("·", o.dim) : null, d.author ? txt(`by ${d.author}`, o.muted) : null,
        d.source ? txt("·", o.dim) : null, d.source ? txt(`via ${d.source}`, o.dim) : null,
      ]))
      .when(Boolean(x?.error), (el) => el.child(this.field(o, "Error", div().flex_1().min_w(0).text_size(12.5).text_color(o.fix).child(x.error))))
      .when(d.state === "ERROR" && ag.length === 0, (el) => el.child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.accent, 0.1))
        .child(icon("play", o.accent, 15))
        .child(div().flex_1().min_w(0).text_color(o.fg).child(`Start: an agent in a tab of ${this.spaceFor(d)?.name ?? "the space shown"}, told to find why the build failed and fix it`))
        .child(h_flex().id("start-btn").flex_none().h(26).px(10).items_center().rounded(6).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => this.startAgent(cx))
          .child(div().text_size(12).font_semibold().text_color(o.surface).child("Start")))))
      .when(ag.length > 0, (el) => el.child(
        v_flex().flex_none().gap(1)
          .child(div().px(2).pb(2).text_size(10.5).font_semibold().text_color(o.dim).child(`AGENTS ${ag.length}`))
          .children(ag.slice(0, 4).map((a, i) => h_flex().id(`ag-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
            .on_click(() => {
              this.dismiss();
              run("agent.focus", { terminal: a.address });
            })
            .child(a.status === "working" ? icon("work", o.work, 14).spin(1100) : a.status === "blocked" ? icon("need", o.need, 14) : icon("idle", o.dim, 14))
            .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(o.fg).child(a.name))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11.5).text_color(o.dim).child(a.status ?? ""))))))
      .child(div().flex_none().h(1).bg(o.line))
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(o.dim).child(BUSY.has(d.state) ? "BUILD LOG · LIVE" : "BUILD LOG · LAST LINES"))
      .child(v_flex().id("dp-body").h(320).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6)
        .child(log
          ? TextView.markdown(`md-${d.id}-${x.log.length}`, log).selectable(true).text_size(12).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))
          : div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…")));
  }

  menuView(o) {
    const m = this.menu;
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(m.title))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click((_e, cx) => this.choose(it, cx))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1)))
          .when(Boolean(it.icon), (el) => el.child(icon(it.icon, o.muted, 13)))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, fn, id);
    if (this.menu) {
      return [k(["↑", "↓"], "choose", () => {}, "f-ch"), k(["enter"], "do it", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "deployment") {
      const d = this.cur;
      return [
        k(["o"], "open", (cx) => this.open(d.url, cx), "f-o"),
        k(["i"], "dashboard", (cx) => this.open(this.dashboard(d), cx), "f-i"),
        k(["c"], "redeploy · promote", (cx) => this.actionsMenu(cx), "f-c"),
        ...(d.pr ? [k(["g"], `PR #${d.pr}`, (cx) => this.openPR(cx), "f-g")] : []),
        ...(d.state === "ERROR" || this.agentsOf(d).length ? [k(["s"], this.agentsOf(d).length ? "its agent" : "start", (cx) => this.startAgent(cx), "f-s")] : []),
        k(["y"], "copy URL", (cx) => this.copy(`https://${d.url}`, cx), "f-y"),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.signedOut) return [k(["esc"], "close", (cx) => this.escape(cx), "f-esc")];
    const sel = this.shown?.[this.at];
    return [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["^o"], "visit", (cx) => sel && this.open(sel.dep.url, cx), "f-o"),
      k(["^y"], "copy URL", (cx) => sel && this.copy(`https://${sel.dep.url}`, cx), "f-y"),
      k(["^s"], "fix build", (cx) => sel && this.startAgent(cx, sel.dep), "f-s"),
      k(["^t"], "project", (cx) => this.switchProject(cx), "f-t"),
      k(["←", "→"], "tabs", (cx) => this.step(1, cx), "f-tab"),
      k(["esc"], "close", (cx) => this.escape(cx), "f-esc"),
    ];
  }

  signInView(o) {
    return v_flex().flex_none().gap(12).px(14).py(18).items_start()
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Sign in to Vercel"))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5).child(
        "Vercel did not accept a token. Signing in opens a terminal here that runs `vercel login`. It opens Vercel in your browser; confirm there, and the CLI keeps the token. The CLI uses it too. Then open this again."))
      .child(h_flex().id("signin-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click(() => this.signIn())
        .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Sign in")));
  }

  render() {
    const t = theme();
    const o = tones(t);
    this.shown = this.shownRows();
    if (this.screen === "list") this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    const scr = this.screen;
    return v_flex()
      .id("vercel")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .when(scr !== "list" || this.signedOut, (el) => el.track_focus(this.keys))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.escape(cx);
        else if (!(scr === "deployment" ? this.depKey(k, cx) : this.menu ? this.menuKey(k, cx) : this.listKey(k, cx))) return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(scr === "list" && !this.signedOut, (el) => el
        .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
          .when(this.demo, (el) => el.child(div().flex_none().text_size(12).text_color(o.muted).child("Demo · made-up team"))))
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(scr === "list" && Boolean(this.signedOut), (el) => el.child(this.signInView(o)))
      .when(scr === "deployment", (el) => el.child(this.depView(o)))
      .when(Boolean(this.menu), (el) => el.child(this.menuView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}

// A deployment's short name: its id without the prefix, as the dashboard
// shows it.
function short(d) {
  return String(d?.id ?? "").replace(/^dpl_/, "").slice(0, 9);
}

// How long it built: so far while it builds.
function built(d) {
  if (!d.buildingAt) return "";
  const end = d.ready && !BUSY.has(d.state) ? d.ready : BUSY.has(d.state) ? Date.now() : null;
  return end ? duration(end - d.buildingAt).replace("<1m", `${Math.max(1, Math.round((end - d.buildingAt) / 1000))}s`) : "";
}

// A deployment as the lists keep it, from the list's answer (`uid`, `state`)
// or one deployment's (`id`, `readyState`, `alias`).
function slim(x) {
  const m = x.meta ?? {};
  const org = m.githubCommitOrg ?? m.githubOrg;
  const repo = m.githubCommitRepo ?? m.githubRepo;
  const pr = m.githubPrId ?? (x.alias ?? []).map((a) => PR_ALIAS.exec(a)?.[1]).find(Boolean) ?? PR_ALIAS.exec(x.url ?? "")?.[1] ?? null;
  // CI builds a pull request's merge ref, whose message is only two SHAs.
  let message = String(m.githubCommitMessage ?? m.gitlabCommitMessage ?? m.bitbucketCommitMessage ?? "").split("\n")[0] || null;
  if (message && /^Merge [0-9a-f]{7,40} into [0-9a-f]{7,40}$/.test(message)) message = pr ? `Pull request #${pr}` : null;
  return {
    id: x.uid ?? x.id,
    name: x.name,
    url: x.url,
    projectId: x.projectId ?? null,
    state: x.readyState ?? x.state,
    target: x.target ?? null,
    created: x.created ?? x.createdAt,
    buildingAt: x.buildingAt ?? null,
    ready: x.ready ?? null,
    inspectorUrl: x.inspectorUrl ?? null,
    source: x.source ?? null,
    branch: m.githubCommitRef ?? m.gitlabCommitRef ?? m.bitbucketCommitRef ?? null,
    sha: m.githubCommitSha ?? m.gitlabCommitSha ?? m.bitbucketCommitSha ?? null,
    message,
    author: m.githubCommitAuthorLogin ?? m.githubCommitAuthorName ?? x.creator?.username ?? null,
    repo: org && repo ? `${org}/${repo}` : null,
    pr: pr ? String(pr) : null,
  };
}
