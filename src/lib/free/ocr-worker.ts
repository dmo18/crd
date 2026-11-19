import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { errorKind, log } from "@/lib/log";

/**
 * Talks to the text reader worker (ocr/worker.py, RapidOCR) running as one
 * long-lived child process. One job at a time; a job that takes too long
 * stops the worker, and the next job starts a fresh one. Pictures go to the
 * worker as PNG files in a private folder (only this process can open it),
 * never through a shell. Every answer is checked with zod and capped in size.
 * After some idle minutes the worker is stopped to free its memory; the next
 * job starts it again. Never logs image data or read text.
 */

/** One line of text as the worker found it, in the picture's pixels. */
export type WorkerLine = { text: string; score: number; box: [number, number][]; turned: boolean };
export type WorkerRead = { width: number; height: number; lines: WorkerLine[] };

/** What the health check may say about the reader: no details. */
export type ReaderStatus = "ready" | "waiting" | "down";

export interface OcrEngine {
  read(png: Buffer): Promise<WorkerRead>;
  status(): ReaderStatus;
  close(): Promise<void>;
}

export type WorkerOptions = {
  /** Program to start, normally the Python of the reader's venv. */
  command: string;
  /** Arguments, normally ["-I", "-B", "<path>/ocr/worker.py"]. */
  args: string[];
  /** Folder with the model files; empty means the worker's default. */
  modelsDir?: string;
  threads?: number;
  /** Longest time to wait for the worker to load its models. */
  startTimeoutMs?: number;
  /** Longest time one picture may take. */
  jobTimeoutMs?: number;
  /** The worker is stopped after this long without a job; 0 keeps it running. */
  idleMs?: number;
};

export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 400;
const MAX_TEXT = 200;
const DEFAULT_START_MS = 90_000;
const DEFAULT_JOB_MS = 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;

const Point = z.tuple([z.number().finite(), z.number().finite()]);
const LineSchema = z.object({
  text: z.string().max(MAX_TEXT),
  score: z.number().min(0).max(1),
  box: z.array(Point).length(4),
  turned: z.boolean(),
});
const Ready = z.object({ ready: z.literal(true) });
const Done = z.object({
  id: z.number().int(),
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
  lines: z.array(LineSchema).max(MAX_LINES),
});
const Failed = z.object({ id: z.number().int(), error: z.string().max(64) });

type Pending = { id: number; resolve: (r: WorkerRead) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const READ_FAILED = "Could not read text from the photo.";

/**
 * The reader itself is not working (could not start, crashed, took too long
 * or answered nonsense), as opposed to one picture it could not read. The
 * scan should fail, not end with an empty card.
 */
export class ReaderDownError extends Error {
  constructor() {
    super(READ_FAILED);
    this.name = "ReaderDownError";
  }
}

/** One picture the worker could not read; the worker itself is fine. */
function readError(): Error {
  return new Error(READ_FAILED);
}

/** Job folders still on disk, removed when the process ends (best effort). */
const liveDirs = new Set<string>();
let exitHookSet = false;

/** Removes every job folder still on disk. Runs when the process ends. */
export function removeJobFolders(): void {
  for (const d of [...liveDirs]) removeDir(d);
}

function removeDir(dir: string) {
  liveDirs.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a folder left in the temp folder is harmless.
  }
}

function trackDir(dir: string) {
  liveDirs.add(dir);
  if (exitHookSet) return;
  exitHookSet = true;
  process.on("exit", removeJobFolders);
}

export class WorkerClient implements OcrEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private ready = false;
  private failed = false;
  private buffer = "";
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private jobDir: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private jobs = 0;
  private readonly opts: Required<Omit<WorkerOptions, "modelsDir">> & { modelsDir: string };

  constructor(options: WorkerOptions) {
    this.opts = {
      command: options.command,
      args: options.args,
      modelsDir: options.modelsDir ?? "",
      threads: options.threads ?? 4,
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_MS,
      jobTimeoutMs: options.jobTimeoutMs ?? DEFAULT_JOB_MS,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
    };
  }

  status(): ReaderStatus {
    if (this.child && this.ready) return "ready";
    return this.failed ? "down" : "waiting";
  }

  /** Reads one PNG. Jobs run one after another, never two at once. */
  read(png: Buffer): Promise<WorkerRead> {
    const run = this.queue.then(() => this.runJob(png), () => this.runJob(png));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    this.clearIdle();
    this.stop();
    this.dropDir();
  }

  /** The job folder of the running worker, for tests. */
  jobFolder(): string | null {
    return this.jobDir;
  }

  private dropDir() {
    if (this.jobDir) removeDir(this.jobDir);
    this.jobDir = null;
  }

  /** A fresh private folder for a new worker; the old one is removed. */
  private freshDir(): string {
    this.dropDir();
    // mkdtemp makes the folder readable by this user only (mode 700).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crd-ocr-"));
    trackDir(dir);
    this.jobDir = dir;
    return dir;
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** After the last job, stop the worker when no new job comes for a while. */
  private armIdle() {
    this.clearIdle();
    if (this.opts.idleMs <= 0 || !this.child) return;
    const timer = setTimeout(() => {
      if (this.idleTimer !== timer) return;
      this.idleTimer = null;
      if (this.jobs > 0 || this.pending || this.starting) return;
      // Stopped to free memory, not broken: health shows "waiting".
      this.stop();
      this.failed = false;
      this.dropDir();
    }, this.opts.idleMs);
    // Never the reason the app keeps running.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private async runJob(png: Buffer): Promise<WorkerRead> {
    this.clearIdle();
    this.jobs++;
    try {
      // A running worker only reads from the folder it was started with: if
      // that folder is gone, start a fresh worker with a fresh folder.
      if (this.child && (!this.jobDir || !fs.existsSync(this.jobDir))) this.stop();
      const child = await this.ensureStarted();
      const dir = this.jobDir!;
      const id = this.nextId++;
      const file = path.join(dir, `job-${id}.png`);
      fs.writeFileSync(file, png, { mode: 0o600 });
      try {
        return await new Promise<WorkerRead>((resolve, reject) => {
          if (this.child !== child) return reject(new ReaderDownError());
          const timer = setTimeout(() => this.broken(), this.opts.jobTimeoutMs);
          this.pending = { id, resolve, reject, timer };
          child.stdin.write(`${JSON.stringify({ id, image: file })}\n`);
        });
      } finally {
        fs.rmSync(file, { force: true });
      }
    } finally {
      this.jobs--;
      if (this.jobs === 0) this.armIdle();
    }
  }

  private ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.ready) return Promise.resolve(this.child);
    if (!this.starting) {
      const started = this.start();
      this.starting = started;
      started.then(
        () => { this.starting = null; },
        () => { this.starting = null; },
      );
    }
    return this.starting;
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    // Each worker gets a fresh folder; the last worker's folder is removed.
    let dir: string;
    try {
      dir = this.freshDir();
    } catch (err) {
      this.failed = true;
      log.warn("text_reader_start_failed", { kind: errorKind(err), errno: codeOf(err) });
      return Promise.reject(new ReaderDownError());
    }
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      OMP_NUM_THREADS: String(this.opts.threads),
      OPENBLAS_NUM_THREADS: "1",
      // onnxruntime's usage telemetry would reach out to Microsoft: off.
      ORT_DISABLE_TELEMETRY: "1",
      CRD_OCR_THREADS: String(this.opts.threads),
      CRD_OCR_JOB_DIR: dir,
      CRD_OCR_MODELS_DIR: this.opts.modelsDir,
    };
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // No shell, a fixed argument list and only the settings the reader
        // needs: none of the app's secrets reach the child.
        child = spawn(this.opts.command, this.opts.args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: dir,
          env: childEnv as NodeJS.ProcessEnv,
        });
      } catch (err) {
        this.failed = true;
        log.warn("text_reader_start_failed", { kind: errorKind(err), errno: codeOf(err) });
        reject(new ReaderDownError());
        return;
      }
      this.child = child;
      this.ready = false;
      this.buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.failed = true;
        log.warn("text_reader_start_failed", { kind: "timeout", errno: "" });
        this.stop();
        reject(new ReaderDownError());
      }, this.opts.startTimeoutMs);
      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        this.failed = false;
        resolve(child);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(child, chunk, onReady));
      // The worker's own messages are drained and dropped: they may hold paths.
      child.stderr.on("data", () => undefined);
      child.stdin.on("error", () => undefined);
      child.on("error", (err) => {
        // Only the kind and code (like ENOENT for a missing Python): the
        // message holds the program's path.
        log.warn("text_reader_start_failed", { kind: errorKind(err), errno: codeOf(err) });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.failed = true;
          reject(new ReaderDownError());
        }
        this.onExit(child);
      });
      child.on("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.failed = true;
          reject(new ReaderDownError());
        }
        if (this.child === child) {
          this.failed = true;
          log.warn("text_reader_stopped", { code: code ?? -1, signal: signal ?? "" });
        }
        this.onExit(child);
      });
    });
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: string, onReady: () => void) {
    if (this.child !== child) return;
    this.buffer += chunk;
    let nl: number;
    while (this.child === child && (nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > MAX_REPLY_BYTES) return this.broken();
      this.onLine(line, onReady);
    }
    // An answer this large is not a real read: stop the worker.
    if (this.buffer.length > MAX_REPLY_BYTES) this.broken();
  }

  /** The worker sent something it never should: stop it, fail the job. */
  private broken() {
    this.buffer = "";
    this.failed = true;
    this.stop();
  }

  private onLine(line: string, onReady: () => void) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.broken();
    }
    if (!this.ready) {
      if (Ready.safeParse(value).success) onReady();
      else this.broken();
      return;
    }
    const done = Done.safeParse(value);
    const p = this.pending;
    if (done.success && p && done.data.id === p.id) {
      this.pending = null;
      clearTimeout(p.timer);
      const { width, height, lines } = done.data;
      p.resolve({ width, height, lines: lines as WorkerLine[] });
      return;
    }
    const failed = Failed.safeParse(value);
    if (failed.success && p && failed.data.id === p.id) {
      // One picture the worker could not read; the worker itself is fine.
      this.fail(readError());
      return;
    }
    // Anything else means the worker and the app disagree: start over.
    this.broken();
  }

  private fail(error: Error) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(error);
  }

  private onExit(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.fail(new ReaderDownError());
  }

  /** Stops the worker now. The next job starts a fresh one. */
  private stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      child.stdout.removeAllListeners("data");
      child.kill("SIGKILL");
    }
    this.fail(new ReaderDownError());
  }
}

/** A system error code like ENOENT, never a message or path. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "";
}
