// Default SF3Encoder: runs mediabunny + @mediabunny/server (FFmpeg/libvorbis)
// in a pool of long-lived worker processes so module load / native init is
// paid once per worker, not once per sample.
//
// Each encode still uses a fresh mediabunny Output inside the worker (see
// _vorbis-worker.ts). That does NOT fully protect against crashes, though:
// testing against real SF2 samples shows the underlying native binding
// (node-av, via @mediabunny/server) can segfault (SIGSEGV) after a handful
// of encodes in the same process -- this reproduces with upstream unchanged,
// so it looks like a native-side resource leak/corruption bug in node-av
// itself, not something fixable from here. It's data-dependent: as few as
// 3-4 real samples in a row can trigger it, though many more small/silent
// ones may not. Two mitigations, both below:
//   1. Each worker is proactively retired after `maxUsesPerWorker` encodes,
//      before it's statistically likely to hit the bug.
//   2. If a worker still dies mid-encode, that one sample is retried (up to
//      `maxRetries` times) on a fresh worker rather than aborting the whole
//      batch -- previously an uncaught worker crash reject()ed the encode
//      Promise, which propagated out of write()'s Promise.all() and killed
//      every other in-flight sample too, i.e. one bad sample lost the whole
//      conversion.
//
// Spawning uses node:child_process so the same path works under Deno
// (Node-compat) and Node. Deno.Command is avoided because @deno/dnt's Deno
// shim does not type/support it yet.
import { type ChildProcess, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import type { SF3Encoder } from "@marmooo/soundfont";

export interface DefaultEncoderOptions {
  // bitrate handed to the Vorbis encoder is `sampleRate * bitsPerHz`
  // (bitrate needs to scale with sample rate -- see _vorbis-worker.ts).
  // Defaults to 4, which is roughly 176 kbps at 44.1 kHz. Lower (e.g. 2)
  // means smaller/lower quality; libvorbis's encoder setup rejects
  // bitrates that are too high for the sample rate, so values above ~5
  // start failing in testing -- stick to roughly 2-5.
  bitsPerHz?: number;
  // How many persistent worker processes to keep. Defaults to
  // navigator.hardwareConcurrency (or 4). Each concurrent encode occupies
  // one worker; excess encodes queue.
  poolSize?: number;
  // Retire (kill, then respawn on next use) a worker after this many
  // encodes, as a preemptive defense against the native crash described
  // above -- lower cuts crash frequency further but spawns more processes.
  // Defaults to 8; empirically the crash was never seen before use #3 on
  // large samples, so 8 is already a fairly tight margin, not a loose one.
  maxUsesPerWorker?: number;
  // If a worker dies mid-encode, how many additional attempts (each on a
  // freshly spawned worker) to make before giving up and throwing. Defaults
  // to 2 (so up to 3 attempts total per sample).
  maxRetries?: number;
}

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && typeof d.execPath === "function";
}

function resolveWorkerPath(): string {
  // Match this module's extension: source tree is .ts, dnt/npm output is .js.
  // Do not key off isDenoRuntime() alone -- Deno loading the npm package
  // still needs .js.
  const self = import.meta.url;
  const workerRel = self.endsWith(".ts")
    ? "./_vorbis-worker.ts"
    : "./_vorbis-worker.js";
  const workerUrl = new URL(workerRel, self);
  if (isDenoRuntime()) {
    // deno run accepts a file URL
    return workerUrl.href;
  }
  return fileURLToPath(workerUrl);
}

function writeStderr(data: Uint8Array): void {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.stderr.writeSync(data);
  } else {
    process.stderr.write(data);
  }
}

function defaultPoolSize(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
}

function putU32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

class WorkerSession {
  private stdoutBuf = Buffer.alloc(0);
  private stdoutWaiters: Array<() => void> = [];
  private dead = false;
  private exitCode: number | null = null;
  // Number of encode() calls this worker has completed or attempted -- used
  // by the pool to retire it after maxUsesPerWorker (see module comment).
  uses = 0;

  constructor(readonly child: ChildProcess) {
    child.stdout!.on("data", (chunk: Buffer) => {
      this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
      this.notifyStdout();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      writeStderr(chunk);
    });
    child.on("error", () => {
      this.dead = true;
      this.notifyStdout();
    });
    child.on("close", (code) => {
      this.dead = true;
      this.exitCode = code;
      this.notifyStdout();
    });
  }

  private notifyStdout() {
    // Snapshot first: tryRead may re-register on the same array while we iterate.
    const waiters = this.stdoutWaiters;
    this.stdoutWaiters = [];
    for (const w of waiters) w();
  }

  private readExact(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        if (this.stdoutBuf.length >= n) {
          const out = this.stdoutBuf.subarray(0, n);
          this.stdoutBuf = this.stdoutBuf.subarray(n);
          resolve(out);
          return;
        }
        if (this.dead) {
          reject(
            new Error(
              `worker exited (code=${this.exitCode}) with only ${this.stdoutBuf.length}/${n} bytes`,
            ),
          );
          return;
        }
        this.stdoutWaiters.push(tryRead);
      };
      tryRead();
    });
  }

  async encode(
    pcm: Int16Array,
    sampleRate: number,
    bitsPerHz: number,
  ): Promise<{ data: Uint8Array; sampleRate: number }> {
    if (this.dead) throw new Error("worker is dead");
    this.uses++;

    const pcmBytes = Buffer.from(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength,
    );
    const header = Buffer.concat([
      putU32le(pcmBytes.byteLength),
      putU32le(sampleRate),
      putU32le(Math.round(bitsPerHz * 1000)),
    ]);
    this.child.stdin!.write(header);
    this.child.stdin!.write(pcmBytes);

    const rateBuf = await this.readExact(4);
    const lenBuf = await this.readExact(4);
    const actualSampleRate = rateBuf.readUInt32LE(0);
    const oggLen = lenBuf.readUInt32LE(0);
    const ogg = await this.readExact(oggLen);
    return {
      data: new Uint8Array(ogg.buffer, ogg.byteOffset, ogg.byteLength),
      sampleRate: actualSampleRate,
    };
  }

  kill() {
    try {
      this.child.stdin!.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
    this.dead = true;
  }

  get isDead() {
    return this.dead;
  }
}

function spawnWorker(workerPath: string): WorkerSession {
  const deno = isDenoRuntime();
  // deno-lint-ignore no-explicit-any
  const cmd = deno ? (globalThis as any).Deno.execPath() : process.execPath;
  const args = deno
    ? ["run", "--node-modules-dir=auto", "-A", workerPath, "serve"]
    : [workerPath, "serve"];

  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  return new WorkerSession(child);
}

/**
 * Creates an SF3Encoder backed by a pool of persistent `_vorbis-worker`
 * processes. Workers are started lazily on first encode (after optional
 * warm-up). Call `dispose()` on the returned function if present to kill
 * workers early; otherwise they exit when the parent process exits.
 */
export function createDefaultEncoder(
  options: DefaultEncoderOptions = {},
): SF3Encoder & { dispose?: () => void } {
  const bitsPerHz = options.bitsPerHz ?? 4;
  const poolSize = Math.max(1, options.poolSize ?? defaultPoolSize());
  const maxUsesPerWorker = Math.max(1, options.maxUsesPerWorker ?? 8);
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const workerPath = resolveWorkerPath();

  const idle: WorkerSession[] = [];
  const waiters: Array<(w: WorkerSession) => void> = [];
  let started = 0;
  let disposed = false;

  const acquire = (): Promise<WorkerSession> =>
    new Promise((resolve) => {
      while (idle.length > 0) {
        const w = idle.pop()!;
        if (!w.isDead && w.uses < maxUsesPerWorker) {
          resolve(w);
          return;
        }
        // drop dead or well-used worker; will respawn below if needed
        if (!w.isDead) w.kill();
        started = Math.max(0, started - 1);
      }
      if (started < poolSize) {
        started++;
        resolve(spawnWorker(workerPath));
        return;
      }
      waiters.push(resolve);
    });

  const release = (w: WorkerSession) => {
    if (disposed || w.isDead || w.uses >= maxUsesPerWorker) {
      // Whether it was already dead or is alive but being retired here
      // (past maxUsesPerWorker), it no longer counts toward `started` —
      // forgetting this branch leaks the count and eventually wedges the
      // whole pool: started saturates at poolSize with no live workers
      // left to satisfy it, so acquire() queues forever and the process
      // hangs with no pending I/O ("top-level await never resolved").
      if (!w.isDead) w.kill();
      started = Math.max(0, started - 1);
      // wake a waiter by spawning replacement if under capacity
      if (!disposed && waiters.length > 0 && started < poolSize) {
        started++;
        waiters.shift()!(spawnWorker(workerPath));
      }
      return;
    }
    const next = waiters.shift();
    if (next) next(w);
    else idle.push(w);
  };

  const releaseAfterUse = (w: WorkerSession) => {
    if (!w.isDead) {
      release(w);
      return;
    }
    // Already dead: nothing to push back to idle. started was already
    // decremented by whoever detected the death (acquire/attemptOnce);
    // just try to wake a waiter with a fresh worker.
    const next = waiters.shift();
    if (!disposed && next && started < poolSize) {
      started++;
      next(spawnWorker(workerPath));
    }
  };

  async function attemptOnce(
    pcm: Int16Array,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; sampleRate: number }> {
    const worker = await acquire();
    try {
      return await worker.encode(pcm, sampleRate, bitsPerHz);
    } catch (err) {
      // Worker likely crashed mid-encode (see module comment): drop it and
      // let the caller decide whether to retry on a fresh one.
      worker.kill();
      started = Math.max(0, started - 1);
      throw err;
    } finally {
      releaseAfterUse(worker);
    }
  }

  const encode: SF3Encoder & { dispose?: () => void } = async (
    pcm,
    sampleRate,
  ) => {
    if (disposed) throw new Error("encoder disposed");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await attemptOnce(pcm, sampleRate);
      } catch (err) {
        lastErr = err;
        // Loop again for another attempt, unless this was the last one.
      }
    }
    throw lastErr;
  };

  encode.dispose = () => {
    disposed = true;
    for (const w of idle) w.kill();
    idle.length = 0;
  };

  return encode;
}
