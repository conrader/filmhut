// F4 — surviving process death with a paid job in flight.
//
// The defect: a CLI submits to the provider, receives a request id, and then
// polls. Between those two moments the id exists only in that process's memory,
// and the exit handlers DELETE the pending sidecar. So a Ctrl-C, a viewer
// restart, or a sleeping laptop leaves the user charged for work they can no
// longer identify, let alone collect.
//
// Two changes close it, and both stay inside the mechanism that already exists:
//
//   1. The provider's id is written into the sidecar, with fsync, BEFORE the
//      first poll. After that line a dead process is recoverable.
//   2. Shutdown marks the sidecar resumable instead of unlinking it. The record
//      of a paid job is the last thing that should be thrown away on the way
//      out.
//
// Deliberately NOT a second store. The `.pending/` sidecars are already watched
// by chokidar and broadcast to the browser; a parallel database would give two
// sources of truth for one fact, and the UI would keep believing the one it
// watches.

import fs from "node:fs";
import path from "node:path";

const PENDING_DIR_NAME = ".pending";

function pendingDir(cwd = process.cwd()) {
  return path.join(cwd, PENDING_DIR_NAME);
}

function pendingPath(jobId, cwd = process.cwd()) {
  return path.join(pendingDir(cwd), `${jobId}.json`);
}

function readSidecarSync(jobId, cwd) {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(jobId, cwd), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the sidecar and flush it to disk before returning. A plain writeFile
 * can sit in the page cache, which is exactly the window a crash exploits — and
 * this data exists specifically to survive a crash.
 */
function writeSidecarDurable(jobId, payload, cwd) {
  const target = pendingPath(jobId, cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Record the provider's job reference. Call IMMEDIATELY after submit returns
 * and before the first poll — that ordering is the whole point of the function.
 *
 * Returns false when no sidecar exists (a CLI run outside a project directory),
 * which is harmless: nothing was tracking that job anyway.
 */
export function recordProviderRef(jobId, providerRef, cwd = process.cwd()) {
  if (!jobId || typeof providerRef !== "string" || providerRef.trim() === "") return false;
  const sidecar = readSidecarSync(jobId, cwd);
  if (!sidecar) return false;
  sidecar.provider_ref = providerRef.trim();
  sidecar.submitted_at = new Date().toISOString();
  writeSidecarDurable(jobId, sidecar, cwd);
  return true;
}

/**
 * Mark a job resumable on the way out, instead of deleting it.
 *
 * A job with no provider_ref never reached the supplier, or reached it without
 * us learning the id — nothing is owed and nothing can be collected, so those
 * are removed as before. Only jobs that cost money are kept.
 */
export function markResumableSync(jobId, cwd = process.cwd()) {
  if (!jobId) return "missing";
  const sidecar = readSidecarSync(jobId, cwd);
  if (!sidecar) return "missing";

  if (!sidecar.provider_ref) {
    try {
      fs.unlinkSync(pendingPath(jobId, cwd));
    } catch {
      /* already gone */
    }
    return "discarded";
  }

  sidecar.resumable = true;
  sidecar.interrupted_at = new Date().toISOString();
  try {
    writeSidecarDurable(jobId, sidecar, cwd);
    return "resumable";
  } catch {
    return "failed";
  }
}

/** Jobs left behind by a process that died holding them. */
export function listResumable(cwd = process.cwd()) {
  let names = [];
  try {
    names = fs.readdirSync(pendingDir(cwd));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sidecar = readSidecarSync(name.slice(0, -5), cwd);
    if (sidecar?.resumable && sidecar?.provider_ref) out.push(sidecar);
  }
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Clear the flag once a job is being polled again. */
export function clearResumable(jobId, cwd = process.cwd()) {
  const sidecar = readSidecarSync(jobId, cwd);
  if (!sidecar) return false;
  delete sidecar.resumable;
  delete sidecar.interrupted_at;
  sidecar.resumed_at = new Date().toISOString();
  writeSidecarDurable(jobId, sidecar, cwd);
  return true;
}

/**
 * Install exit handlers that preserve paid work.
 *
 * Replaces the previous `removePendingSync` handlers. Returns a disposer so a
 * CLI that finishes normally stops holding the process open.
 */
export function protectOnExit(jobId, cwd = process.cwd()) {
  const onSignal = (signal, code) => () => {
    markResumableSync(jobId, cwd);
    process.exit(code);
  };
  const onInt = onSignal("SIGINT", 130);
  const onTerm = onSignal("SIGTERM", 143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}
