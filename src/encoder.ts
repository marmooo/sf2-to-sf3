// Default SF3Encoder: runs mediabunny + @mediabunny/server (FFmpeg/libvorbis)
// in a pool of long-lived worker processes so module load / native init is
// paid once per worker, not once per sample.
//
// Each encode still uses a fresh mediabunny Output inside the worker (see
// _vorbis-worker.ts). Reusing one native encoder *object* across samples has
// been observed to crash; reusing the process with isolated encodes has not.
//
// Spawning uses node:child_process so the same path works under Deno
// (Node-compat) and Node. Deno.Command is avoided because @deno/dnt's Deno
// shim does not type/support it yet.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SF3Encoder } from "@marmooo/soundfont";

export interface DefaultEncoderOptions {
  // bitrate handed to the Vorbis encoder is `sampleRate * bitsPerHz`
  // (bitrate needs to scale with sample rate — see _vorbis-worker.ts).
  // Defaults to 4, which is roughly 176 kbps at 44.1 kHz. Lower (e.g. 2)
  // means smaller/lower quality; libvorbis's encoder setup rejects
  // bitrates that are too high for the sample rate, so values above ~5
  // start failing in testing — stick to roughly 2-5.
  bitsPerHz?: number;
  // How many persistent worker processes to keep. Defaults to
  // navigator.hardwareConcurrency (or 4). Each concurrent encode occupies
  // one worker; excess encodes queue.
  poolSize?: number;
}

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && typeof d.execPath === "function";
}

function resolveWorkerPath(): string {
  // Match this module's extension: source tree is .ts, dnt/npm output is .js.
  // Do not key off isDenoRuntime() alone — Deno loading the npm package
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
  const workerPath = resolveWorkerPath();

  const idle: WorkerSession[] = [];
  const waiters: Array<(w: WorkerSession) => void> = [];
  let started = 0;
  let disposed = false;

  const acquire = (): Promise<WorkerSession> =>
    new Promise((resolve) => {
      while (idle.length > 0) {
        const w = idle.pop()!;
        if (!w.isDead) {
          resolve(w);
          return;
        }
        // drop dead worker; will respawn below if needed
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
    if (disposed || w.isDead) {
      if (w.isDead) started = Math.max(0, started - 1);
      else w.kill();
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

  const encode: SF3Encoder & { dispose?: () => void } = async (
    pcm,
    sampleRate,
  ) => {
    if (disposed) throw new Error("encoder disposed");
    const worker = await acquire();
    try {
      return await worker.encode(pcm, sampleRate, bitsPerHz);
    } catch (err) {
      // Worker likely crashed mid-encode; drop it and surface the error.
      worker.kill();
      started = Math.max(0, started - 1);
      throw err;
    } finally {
      if (!worker.isDead) release(worker);
      else {
        // already counted down in catch or kill
        const next = waiters.shift();
        if (next && started < poolSize) {
          started++;
          next(spawnWorker(workerPath));
        }
      }
    }
  };

  encode.dispose = () => {
    disposed = true;
    for (const w of idle) w.kill();
    idle.length = 0;
  };

  return encode;
}
