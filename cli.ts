import { parse } from "@marmooo/soundfont";
import { parseArgs } from "@std/cli";
import { sf2ToSf3 } from "./src/mod.ts";

const VERSION = "0.0.3";

const args = parseArgs(Deno.args, {
  string: ["quality", "concurrency"],
  boolean: ["recompress", "version", "help"],
  alias: {
    V: "version",
    q: "quality",
    c: "concurrency",
    r: "recompress",
    h: "help",
  },
});

const usage = `Usage: sf2-to-sf3 <input.sf2|sf3> <output.sf3> [options]

Convert SF2 to SF3.

Options:
  -V, --version      output the version number
  -q, --quality      Vorbis VBR quality ([-1, 10], default 4)
  -c, --concurrency  max parallel sample encodes
                       default: hardwareConcurrency or 4
  -r, --recompress   re-encode already-compressed (SF3) samples at
                     --quality instead of copying them through as-is
                       default: false
  -h, --help         display help for command`;

if (args.version) {
  console.log(VERSION);
  Deno.exit(0);
}

if (args.help) {
  console.log(usage);
  Deno.exit(0);
}

const inputPath = args._[0] as string;
const outputPath = args._[1] as string;

if (!inputPath || !outputPath) {
  console.error(usage);
  Deno.exit(1);
}

const qualityArg = args.quality;
const concurrencyArg = args.concurrency;
const recompress = args.recompress;

const file = Deno.readFileSync(inputPath);
const soundFont = parse(file);

const sf3Bytes = await sf2ToSf3(soundFont, {
  quality: qualityArg ? Number(qualityArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
  recompress,
});

Deno.writeFileSync(outputPath, sf3Bytes);
console.log(`wrote ${outputPath} (${sf3Bytes.byteLength} bytes)`);
