#!/usr/bin/env node
// Collect jobs left behind by a process that died mid-flight.
//
//   node resume_jobs.js            list what is recoverable
//   node resume_jobs.js --poll     ask the provider about each, and write a
//                                  durable result for anything that finished
//
// The provider polls by request id alone, so this needs no per-capability
// knowledge — the id recorded in the sidecar is enough for any of them.

import { pollJob } from "../deapi_client.js";
import { emitSuccess } from "./_cli.js";
import { clearResumable, listResumable } from "./_resume.js";
import { writeResultSidecar } from "./_pending.js";

const args = new Set(process.argv.slice(2));
const doPoll = args.has("--poll");

const jobs = listResumable();

if (jobs.length === 0) {
  emitSuccess({ ok: true, resumable: 0, jobs: [], note: "nothing left behind" });
  process.exit(0);
}

const summary = jobs.map((j) => ({
  job_id: j.id,
  kind: j.kind,
  provider_ref: j.provider_ref,
  prompt: typeof j.prompt === "string" ? j.prompt.slice(0, 80) : undefined,
  cost_usd: j.cost_usd,
  interrupted_at: j.interrupted_at,
}));

if (!doPoll) {
  emitSuccess({
    ok: true,
    resumable: jobs.length,
    jobs: summary,
    note: "run with --poll to ask the provider whether these finished",
  });
  process.exit(0);
}

const results = [];
let recovered = 0;

for (const job of jobs) {
  try {
    // Short budget per job: this is a catch-up sweep, not a render wait. A job
    // still running stays resumable and gets picked up next time.
    const status = await pollJob(job.provider_ref, { timeoutMs: 20_000, intervalMs: 2_000 });
    const url = status?.result_url ?? status?.output?.url ?? null;

    if (url) {
      await writeResultSidecar(job.id, {
        ok: true,
        kind: job.kind,
        recovered: true,
        provider_ref: job.provider_ref,
        output_url: url,
        cost_usd: job.cost_usd ?? null,
        note: "recovered after the original process exited",
      });
      clearResumable(job.id);
      recovered += 1;
      results.push({ job_id: job.id, state: "recovered", output_url: url });
    } else {
      results.push({ job_id: job.id, state: "still_running" });
    }
  } catch (e) {
    // A terminal provider failure means the job is settled, not lost — stop
    // carrying it. Anything else stays resumable for the next sweep.
    const terminal = e?.klass === "bad_args" || e?.klass === "content_filtered";
    if (terminal) {
      await writeResultSidecar(job.id, {
        ok: false,
        klass: e.klass,
        message: e.message,
        provider_ref: job.provider_ref,
        recovered: true,
      });
      clearResumable(job.id);
    }
    results.push({
      job_id: job.id,
      state: terminal ? "failed_at_provider" : "unresolved",
      message: e?.message,
    });
  }
}

emitSuccess({ ok: true, resumable: jobs.length, recovered, jobs: results });
