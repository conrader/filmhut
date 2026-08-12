// F5 — access control.
//
// The load-bearing test here is "default deny": a route nobody thought about
// must still be protected. Everything else guards a specific carrier.

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TOKEN_COOKIE,
  createAuthMiddleware,
  createSocketAuth,
  generateToken,
  loadOrCreateToken,
  presentedToken,
  registerSessionRoute,
  tokenMatches,
} from "../lib/auth.js";

const TOKEN = "test-token-value";

/** Boot a throwaway app with auth mounted the way the viewer mounts it. */
async function appWith({ allowLoopback = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware({ token: TOKEN, allowLoopback }));
  registerSessionRoute({ app, token: TOKEN });
  app.get("/", (_req, res) => res.json({ ok: true }));
  app.get("/projects", (_req, res) => res.json({ ok: true, guarded: true }));
  app.post("/projects/:id/mutate", (_req, res) => res.json({ ok: true, applied: true }));
  // Deliberately added with no thought given to auth — the point of the test.
  app.get("/some/route/nobody/guarded", (_req, res) => res.json({ ok: true }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("default deny: an unguarded route still requires a token", async () => {
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/some/route/nobody/guarded`);
    assert.equal(res.status, 401, "a route nobody protected must not be reachable");
    const body = await res.json();
    assert.equal(body.klass, "auth");
  } finally {
    await close();
  }
});

test("the mutation surface is closed without a token", async () => {
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/projects/scratch/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "addBatch", payload: { nodes: [], edges: [] } }),
    });
    assert.equal(res.status, 401, "this is the endpoint that was open before");
  } finally {
    await close();
  }
});

test("health stays public so a probe does not need the secret", async () => {
  const { base, close } = await appWith();
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    await close();
  }
});

test("every carrier is accepted: header, cookie, query", async () => {
  const { base, close } = await appWith();
  try {
    const header = await fetch(`${base}/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(header.status, 200, "header carrier");

    const cookie = await fetch(`${base}/projects`, { headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
    assert.equal(cookie.status, 200, "cookie carrier — this is what <img> and <video> use");

    const query = await fetch(`${base}/projects?token=${TOKEN}`);
    assert.equal(query.status, 200, "query carrier — for the initial browser hand-off");
  } finally {
    await close();
  }
});

test("a wrong token is refused however it arrives", async () => {
  const { base, close } = await appWith();
  try {
    for (const init of [
      { headers: { authorization: "Bearer nope" } },
      { headers: { cookie: `${TOKEN_COOKIE}=nope` } },
      {},
    ]) {
      assert.equal((await fetch(`${base}/projects`, init)).status, 401);
    }
    assert.equal((await fetch(`${base}/projects?token=nope`)).status, 401);
  } finally {
    await close();
  }
});

test("POST /session exchanges a token for the cookie the media tags need", async () => {
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`${TOKEN_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/i, "the cookie must not be readable from script");

    const bad = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    assert.equal(bad.status, 401, "/session must not mint a cookie for a wrong token");
  } finally {
    await close();
  }
});

test("loopback exemption is opt-out, and off means off", async () => {
  const permissive = await appWith({ allowLoopback: true });
  try {
    assert.equal((await fetch(`${permissive.base}/projects`)).status, 200, "CLIs on the same box");
  } finally {
    await permissive.close();
  }

  const strict = await appWith({ allowLoopback: false });
  try {
    assert.equal((await fetch(`${strict.base}/projects`)).status, 401);
  } finally {
    await strict.close();
  }
});

test("token comparison does not leak length and rejects junk", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "abcdefghij"), false, "differing length must not throw");
  assert.equal(tokenMatches("abc", ""), false);
  assert.equal(tokenMatches("abc", undefined), false);
  assert.equal(tokenMatches("abc", null), false);
});

test("carrier precedence is header, then cookie, then query", () => {
  const req = {
    headers: { authorization: "Bearer from-header", cookie: `${TOKEN_COOKIE}=from-cookie` },
    query: { token: "from-query" },
  };
  assert.equal(presentedToken(req), "from-header");
  assert.equal(presentedToken({ headers: { cookie: `${TOKEN_COOKIE}=from-cookie` }, query: { token: "q" } }), "from-cookie");
  assert.equal(presentedToken({ headers: {}, query: { token: "from-query" } }), "from-query");
  assert.equal(presentedToken({ headers: {}, query: {} }), null);
});

test("a token is minted and persisted on first run, then reused", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-auth-"));
  const envPath = path.join(dir, ".env");
  delete process.env.PAI_TOKEN;

  const first = await loadOrCreateToken(envPath);
  assert.equal(first.created, true);
  assert.ok(first.token.length >= 32, "a generated token must be long");

  const written = await fsp.readFile(envPath, "utf8");
  assert.match(written, /PAI_TOKEN='/, "it must be written where start.sh can read it");

  const second = await loadOrCreateToken(envPath);
  assert.equal(second.created, false, "a second run must not rotate the token");
  assert.equal(second.token, first.token, "rotating would sign the user out on every restart");
});

test("an existing .env is appended to, never truncated", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pai-auth-"));
  const envPath = path.join(dir, ".env");
  await fsp.writeFile(envPath, "DEAPI_KEY='12345|secret'\n");
  delete process.env.PAI_TOKEN;

  await loadOrCreateToken(envPath);
  const after = await fsp.readFile(envPath, "utf8");
  assert.match(after, /DEAPI_KEY='12345\|secret'/, "the user's key must survive");
  assert.match(after, /PAI_TOKEN='/);
});

test("socket handshakes are authenticated at connection", async () => {
  const auth = createSocketAuth({ token: TOKEN, allowLoopback: false });
  const call = (handshake) =>
    new Promise((resolve) => auth({ handshake, request: { socket: {} } }, (err) => resolve(err)));

  assert.equal(await call({ auth: { token: TOKEN }, headers: {}, address: "10.0.0.5" }), undefined);
  assert.equal(await call({ query: { token: TOKEN }, headers: {}, address: "10.0.0.5" }), undefined);
  assert.equal(
    await call({ headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` }, address: "10.0.0.5" }),
    undefined,
  );

  const refused = await call({ auth: { token: "nope" }, headers: {}, address: "10.0.0.5" });
  assert.ok(refused instanceof Error, "pty:spawn must be unreachable without the token");
});

test("generated tokens are unique and url-safe", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "must survive a query string without escaping");
});

test("a query token mints the cookie, so the browser can load the bundle", async () => {
  // The failure this prevents: the launch URL carries ?token=, the shell loads,
  // and then every asset the shell references 401s because a <script src> and a
  // <link rel=stylesheet> cannot attach a token. The page goes blank and the
  // user has no idea why.
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/projects?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`${TOKEN_COOKIE}=`), "entering with a query token must leave a cookie behind");
    assert.match(setCookie, /HttpOnly/i);
  } finally {
    await close();
  }
});

test("a wrong query token mints nothing", async () => {
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/projects?token=nope`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null, "a failed attempt must not leave a usable cookie");
  } finally {
    await close();
  }
});

test("a header token does NOT mint a cookie", async () => {
  // Programmatic callers carry their own credential; handing them a session
  // cookie would widen the surface for no benefit.
  const { base, close } = await appWith();
  try {
    const res = await fetch(`${base}/projects`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    await close();
  }
});

test("/healthz stays reachable for a container probe", async () => {
  const { base, close } = await appWith();
  try {
    // A liveness probe that needs the secret restart-loops the container.
    const res = await fetch(`${base}/healthz`);
    assert.notEqual(res.status, 401);
  } finally {
    await close();
  }
});
