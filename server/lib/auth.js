// Access control for the viewer.
//
// The viewer spawns a coding agent with the deAPI key in its environment, and
// applies canvas mutations. Both are consequential enough that "it only listens
// on loopback" is not a control — the launcher can bind to a tailnet address,
// and at that point every device on the network can reach it.
//
// Two rules make this hard to get wrong later:
//
//   1. DEFAULT DENY. Everything requires the token unless it is on an explicit
//      allow-list. A route added next month is protected because it exists, not
//      because someone remembered.
//   2. ONE TOKEN, THREE CARRIERS. Header for programmatic callers, cookie for
//      the browser, query string only where neither is possible. A <video> tag
//      cannot set a header, so without the cookie the canvas would show broken
//      media on an authenticated server.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const TOKEN_COOKIE = "pai_token";
const TOKEN_BYTES = 32;

// Reachable without a token. Deliberately tiny.
//   /            — health probe; reveals nothing but liveness
//   /session     — exchanges a token for the cookie, so it must be reachable
//                  before one exists
const PUBLIC_PATHS = new Set(["/", "/session"]);

/** Loopback callers are exempt: the CLIs run as the same user on the same box. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Read the token, minting and persisting one on first run.
 *
 * A tool that refuses to start until you invent a secret gets its auth turned
 * off. Generating one keeps the default safe AND usable, which is the only
 * combination that survives contact with a real user.
 */
export async function loadOrCreateToken(envPath) {
  const fromEnv = String(process.env.PAI_TOKEN ?? "").trim();
  if (fromEnv) return { token: fromEnv, created: false };

  let contents = "";
  try {
    contents = await fsp.readFile(envPath, "utf8");
  } catch {
    // No .env yet — fall through and create one.
  }

  const existing = /^PAI_TOKEN=['"]?([^'"\n]+)['"]?$/m.exec(contents);
  if (existing?.[1]?.trim()) return { token: existing[1].trim(), created: false };

  const token = generateToken();
  const line = `\n# Generated on first run. Anyone with this value can drive the studio\n# and spend against your deAPI key. Do not commit or paste it.\nPAI_TOKEN='${token}'\n`;
  await fsp.mkdir(path.dirname(envPath), { recursive: true });
  await fsp.appendFile(envPath, contents.endsWith("\n") || contents === "" ? line.slice(1) : line);
  return { token, created: true };
}

/** Constant-time compare that tolerates length mismatch without leaking it. */
export function tokenMatches(expected, presented) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(presented);
  // Hash first so differing lengths do not short-circuit the comparison.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Header, then cookie, then query. Order is preference, not fallback semantics. */
export function presentedToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  const cookie = readCookie(req.headers?.cookie, TOKEN_COOKIE);
  if (cookie) return cookie;
  const q = req.query?.token ?? req.query?.t;
  if (typeof q === "string" && q) return q;
  return null;
}

export function isLoopback(req) {
  const ip = req.socket?.remoteAddress ?? req.ip ?? "";
  return LOOPBACK.has(ip);
}

/**
 * Express middleware. Mount BEFORE any route so nothing can be registered
 * outside it.
 *
 * `allowLoopback` keeps the generation CLIs working without threading a token
 * through every subprocess: they run as the same user on the same machine, and
 * anything that can open a loopback socket here can already read the .env.
 */
export function createAuthMiddleware({ token, allowLoopback = true }) {
  return function authMiddleware(req, res, next) {
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (allowLoopback && isLoopback(req)) return next();

    if (tokenMatches(token, presentedToken(req))) return next();

    // A browser navigating gets a page it can act on; anything else gets JSON.
    if (String(req.headers.accept ?? "").includes("text/html")) {
      res.status(401).type("html").send(UNAUTHORIZED_PAGE);
      return;
    }
    res.status(401).json({ ok: false, klass: "auth", message: "token required" });
  };
}

/**
 * Socket.IO handshake check. The socket surface is the more dangerous of the
 * two: `pty:spawn` starts a shell. Authenticate the connection once rather than
 * each event, so a new event handler cannot forget.
 */
export function createSocketAuth({ token, allowLoopback = true }) {
  return function socketAuth(socket, next) {
    const req = socket.request ?? {};
    const address = socket.handshake?.address ?? "";
    if (allowLoopback && (LOOPBACK.has(address) || isLoopback(req))) return next();

    const presented =
      socket.handshake?.auth?.token ||
      socket.handshake?.query?.token ||
      readCookie(socket.handshake?.headers?.cookie, TOKEN_COOKIE);

    if (tokenMatches(token, presented)) return next();
    next(new Error("unauthorized"));
  };
}

/**
 * POST /session — trade a token for the cookie, so <img> and <video> tags load.
 * This is why the cookie carrier exists at all.
 */
export function registerSessionRoute({ app, token, secure = false }) {
  app.post("/session", (req, res) => {
    const presented = req.body?.token ?? presentedToken(req);
    if (!tokenMatches(token, presented)) {
      return res.status(401).json({ ok: false, klass: "auth", message: "token required" });
    }
    res.cookie(TOKEN_COOKIE, String(presented), {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });
}

const UNAUTHORIZED_PAGE = `<!doctype html><meta charset="utf-8">
<title>Token required</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#070b13;color:#e8edf6;
display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:34rem;padding:2rem;line-height:1.6}h1{font-size:1.4rem;margin:0 0 .6rem}
code{background:#131c2c;padding:.15rem .4rem;border-radius:4px;font-size:.9em}
p{color:#9aa8bd}</style>
<main><h1>Token required</h1>
<p>This studio is protected. Open it using the link printed by
<code>./scripts/start.sh</code>, which carries the access token.</p>
<p>The token is in <code>.env</code> as <code>PAI_TOKEN</code>. Anyone who has it can
drive the studio and spend against your key.</p></main>`;
