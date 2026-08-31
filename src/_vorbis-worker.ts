// Vorbis encode worker for @marmooo/sf2-to-sf3.
//
// Two modes:
//
// 1) One-shot (legacy, argv: <sampleRate> <bitsPerHz>):
//    stdin  → raw s16le mono PCM
//    stdout → u32le actualSampleRate + Ogg Vorbis bytes
//    process exits when done
//
// 2) Persistent pool (argv: "serve"):
//    loop of length-prefixed requests so the parent can reuse the process
//    (mediabunny / native bindings stay loaded — the expensive part).
//    Request:  u32le pcmBytes | u32le sampleRate | u32le bitsPerHzMilli
//              (bitsPerHzMilli = round(bitsPerHz * 1000)) + pcm
//    Response: u32le actualSampleRate | u32le oggBytes | ogg
//    On encode error the process exits non-zero; the parent respawns.
//
// Each encode still builds a fresh mediabunny Output / AudioSampleSource so
// we do not reuse a single native encoder object across samples (that path
// has been observed to crash). Reusing the *process* is fine and removes
// Deno/Node + module load cost per sample.
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  OggOutputFormat,
  Output,
} from "mediabunny";
import { registerMediabunnyServer } from "@mediabunny/server";

registerMediabunnyServer();

const SUPPORTED_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000];

function nearestSupportedRate(rate: number): number {
  let best = SUPPORTED_RATES[0];
  for (const candidate of SUPPORTED_RATES) {
    if (Math.abs(candidate - rate) < Math.abs(best - rate)) best = candidate;
  }
  return best;
}

function resampleLinear(
  pcm: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) return pcm;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = Math.round(pcm[i0] * (1 - frac) + pcm[i1] * frac);
  }
  return out;
}

function isDenoRuntime(): boolean {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return typeof d !== "undefined" && Array.isArray(d.args);
}

function getArgs(): string[] {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).Deno.args as string[];
  }
  return process.argv.slice(2);
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function readStdinAll(): Promise<Uint8Array> {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    return await readStream((globalThis as any).Deno.stdin.readable);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function writeStdout(data: Uint8Array): Promise<void> {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    await (globalThis as any).Deno.stdout.write(data);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }
}

function exit(code: number): never {
  if (isDenoRuntime()) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).Deno.exit(code);
  }
  process.exit(code);
}

async function encodePcm(
  sourcePcm: Int16Array,
  sourceRate: number,
  bitsPerHz: number,
): Promise<{ data: Uint8Array; sampleRate: number }> {
  const targetRate = nearestSupportedRate(sourceRate);
  const pcm = resampleLinear(sourcePcm, sourceRate, targetRate);

  const output = new Output({
    format: new OggOutputFormat(),
    target: new BufferTarget(),
  });
  const audioSource = new AudioSampleSource({
    codec: "vorbis",
    bitrate: Math.round(targetRate * bitsPerHz),
  });
  output.addAudioTrack(audioSource);
  await output.start();

  const sample = new AudioSample({
    data: pcm,
    format: "s16",
    numberOfChannels: 1,
    sampleRate: targetRate,
    timestamp: 0,
  });
  await audioSource.add(sample);
  sample.close();
  audioSource.close();
  await output.finalize();

  return {
    data: new Uint8Array(output.target.buffer!),
    sampleRate: targetRate,
  };
}

// ---- persistent mode: read exact N bytes from stdin ----

class StdinReader {
  private buf = new Uint8Array(0);
  private ended = false;
  private waiters: Array<() => void> = [];

  constructor() {
    if (isDenoRuntime()) {
      this.pumpDeno();
    } else {
      this.pumpNode();
    }
  }

  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private append(chunk: Uint8Array) {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
    this.notify();
  }

  private async pumpDeno() {
    // deno-lint-ignore no-explicit-any
    const reader = (globalThis as any).Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.append(value);
      }
    } finally {
      this.ended = true;
      this.notify();
    }
  }

  private pumpNode() {
    process.stdin.on("data", (chunk: Buffer) => {
      this.append(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    });
    process.stdin.on("end", () => {
      this.ended = true;
      this.notify();
    });
  }

  async readExact(n: number): Promise<Uint8Array | null> {
    while (this.buf.length < n) {
      if (this.ended) {
        if (this.buf.length === 0) return null;
        throw new Error(
          `stdin EOF with ${this.buf.length} bytes left, needed ${n}`,
        );
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

function u32le(buf: Uint8Array, offset = 0): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(
    0,
    true,
  );
}

function putU32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

async function serveLoop(): Promise<void> {
  const stdin = new StdinReader();
  while (true) {
    const header = await stdin.readExact(12);
    if (header === null) return; // clean EOF

    const pcmBytes = u32le(header, 0);
    const sourceRate = u32le(header, 4);
    const bitsPerHzMilli = u32le(header, 8);
    const bitsPerHz = bitsPerHzMilli / 1000;

    const pcmRaw = await stdin.readExact(pcmBytes);
    if (pcmRaw === null) throw new Error("stdin EOF mid-pcm");

    const sourcePcm = new Int16Array(
      pcmRaw.buffer,
      pcmRaw.byteOffset,
      pcmRaw.byteLength / 2,
    );
    const { data, sampleRate } = await encodePcm(
      sourcePcm,
      sourceRate,
      bitsPerHz,
    );

    await writeStdout(putU32le(sampleRate));
    await writeStdout(putU32le(data.byteLength));
    await writeStdout(data);
  }
}

async function oneShot(sourceRate: number, bitsPerHz: number): Promise<void> {
  const pcmBytes = await readStdinAll();
  const sourcePcm = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    pcmBytes.byteLength / 2,
  );
  const { data, sampleRate } = await encodePcm(
    sourcePcm,
    sourceRate,
    bitsPerHz,
  );
  await writeStdout(putU32le(sampleRate));
  await writeStdout(data);
}

async function main(): Promise<void> {
  const args = getArgs();
  if (args[0] === "serve") {
    await serveLoop();
    return;
  }
  const sourceRate = Number(args[0]);
  const bitsPerHz = Number(args[1]);
  await oneShot(sourceRate, bitsPerHz);
}

main()
  .then(() => exit(0))
  .catch((err) => {
    console.error(err);
    exit(1);
  });
