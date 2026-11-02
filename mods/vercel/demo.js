// A made-up Vercel team for the demo (`herdr-app do vercel.demo`): the same
// answers the REST API gives, for the paths the mod asks, so every screen
// works without a token. Changes stay in memory.

const MIN = 60000;
const HOUR = 60 * MIN;

export const DEMO_TEAM = { id: "team_demo", slug: "acme" };
export const DEMO_PROJECTS = [
  { id: "prj_store", slug: "storefront" },
  { id: "prj_docs", slug: "docs" },
];

let n = 0;
const dep = (project, target, state, agoMin, buildMin, branch, message, extra = {}) => {
  const created = Date.now() - agoMin * MIN;
  const id = `dpl_Demo${String(++n).padStart(3, "0")}${project.slice(0, 3)}`;
  const slug = DEMO_PROJECTS.find((p) => p.id === project).slug;
  return {
    uid: id, name: slug, projectId: project, url: `${slug}-${id.slice(4, 13).toLowerCase()}-acme.vercel.app`,
    state, readyState: state, target, created, buildingAt: created + 4000,
    ready: state === "BUILDING" || state === "QUEUED" ? null : created + buildMin * MIN,
    inspectorUrl: `https://vercel.com/acme/${slug}/${id.slice(4)}`, source: "git",
    creator: { username: "you" },
    meta: { githubCommitRef: branch, githubCommitSha: Math.random().toString(16).slice(2).padEnd(40, "0"), githubCommitMessage: message,
      githubCommitAuthorLogin: extra.author ?? "you", githubOrg: "acme", githubRepo: slug, ...(extra.pr ? { githubPrId: String(extra.pr) } : {}) },
    alias: extra.alias ?? [],
    errorMessage: state === "ERROR" ? 'Command "pnpm build" exited with 1' : null,
  };
};

const DEPLOYS = [
  dep("prj_store", "preview", "BUILDING", 1, 0, "cart-totals", "Show tax in the cart summary", { pr: 412 }),
  dep("prj_store", "production", "READY", 34, 2.4, "main", "Merge #409: faster product grid", { alias: ["shop.example.com", "storefront-acme.vercel.app"] }),
  dep("prj_store", "preview", "ERROR", 52, 1.1, "checkout-retry", "Retry the payment session once", { pr: 410, author: "kim" }),
  dep("prj_store", "preview", "READY", 80, 2.2, "product-grid", "Virtualize the product grid", { pr: 409 }),
  dep("prj_store", "preview", "CANCELED", 95, 0.3, "product-grid", "WIP grid", { pr: 409 }),
  dep("prj_store", "production", "READY", 26 * 60, 2.6, "main", "Merge #401: delivery dates in the user's time zone"),
  dep("prj_docs", "production", "READY", 3 * 60, 0.9, "main", "Document the stock API"),
  dep("prj_docs", "preview", "ERROR", 5 * 60, 0.5, "broken-links", "Move the API pages", { pr: 77, author: "kim" }),
];
const CURRENT = { prj_store: DEPLOYS[1].uid, prj_docs: DEPLOYS[6].uid };

const LOG_OK = ["Running build in Washington, D.C., USA (East) – iad1", "Cloning github.com/acme/storefront", "Installing dependencies...", "Done in 6.2s", "> vite build", "✓ 1204 modules transformed.", "Build Completed in /vercel/output [41s]", "Deploying outputs...", "Deployment completed"];
const LOG_ERR = ["Running build in Washington, D.C., USA (East) – iad1", "Cloning github.com/acme/storefront", "Installing dependencies...", "Done in 5.8s", "> vite build", "src/routes/checkout/+page.svelte:42:11", "Error: Cannot find module '$lib/payments/retry'", "  at resolve (vite/dist/node/chunks/dep.js:1203:17)", "Command \"pnpm build\" exited with 1"];
const LOG_BUILDING = ["Running build in Washington, D.C., USA (East) – iad1", "Cloning github.com/acme/storefront", "Installing dependencies...", "Done in 6.0s", "> vite build", "transforming (812) src/lib/cart/summary.ts"];

const find = (id) => DEPLOYS.find((d) => d.uid === id || d.url === id || d.alias.includes(id));
const one = (d) => ({ ...d, id: d.uid });

export function demoApi(method, path, body) {
  const [p, q] = path.split("?");
  const params = Object.fromEntries((q ?? "").split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
  let m;
  if (method === "GET" && p === "/v9/projects") return { projects: DEMO_PROJECTS.map((x) => ({ id: x.id, name: x.slug, targets: { production: { id: CURRENT[x.id] } } })) };
  if (method === "GET" && (m = /^\/v9\/projects\/([^/]+)$/.exec(p))) return { id: m[1], targets: { production: { id: CURRENT[m[1]] } } };
  if (method === "GET" && /^\/v2\/teams/.test(p)) return { id: DEMO_TEAM.id, slug: DEMO_TEAM.slug };
  if (method === "GET" && p === "/v6/deployments") {
    const list = DEPLOYS.filter((d) => (!params.projectId || d.projectId === params.projectId) && (!params.target || d.target === params.target) && (!params.state || d.state === params.state));
    return { deployments: list.sort((a, b) => b.created - a.created) };
  }
  if (method === "GET" && (m = /^\/v13\/deployments\/(.+)$/.exec(p))) {
    const d = find(decodeURIComponent(m[1]));
    if (!d) throw new Error("Vercel: 404 The deployment could not be found.");
    return one(d);
  }
  if (method === "GET" && (m = /^\/v3\/deployments\/([^/]+)\/events$/.exec(p))) {
    const d = find(m[1]);
    const lines = d?.state === "ERROR" ? LOG_ERR : d?.state === "BUILDING" ? LOG_BUILDING : d?.state === "READY" ? LOG_OK : [];
    return lines.map((text, i) => ({ type: /Error|exited/.test(text) ? "stderr" : "stdout", text, created: d.created + i * 1000 })).reverse();
  }
  if (method === "POST" && p === "/v13/deployments") {
    const from = find(body.deploymentId);
    const d = dep(from.projectId, body.target ?? "preview", "BUILDING", 0, 0, from.meta.githubCommitRef, from.meta.githubCommitMessage, { pr: from.meta.githubPrId });
    DEPLOYS.unshift(d);
    return one(d);
  }
  if (method === "POST" && (m = /^\/v10\/projects\/([^/]+)\/promote\/([^/]+)$/.exec(p))) {
    CURRENT[m[1]] = m[2];
    return null;
  }
  if (method === "PATCH" && (m = /^\/v12\/deployments\/([^/]+)\/cancel$/.exec(p))) {
    const d = find(m[1]);
    d.state = d.readyState = "CANCELED";
    return one(d);
  }
  throw new Error(`Demo: no answer for ${method} ${p}`);
}
