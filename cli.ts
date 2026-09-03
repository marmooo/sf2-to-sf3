import { parse } from "@marmooo/soundfont";
import { parseArgs } from "@std/cli";
import { sf2ToSf3 } from "./src/mod.ts";

const args = parseArgs(Deno.args, {
  string: ["quality", "concurrency"],
  boolean: ["recompress"],
  alias: {
    q: "quality",
    c: "concurrency",
    r: "recompress",
  },
});

const inputPath = args._[0] as string;
const outputPath = args._[1] as string;

if (!inputPath || !outputPath) {
  console.error(`Usage: sf2-to-sf3 <input.sf2|sf3> <output.sf3> [options]

Convert SF2 to SF3.

Options:
  -q, --quality      Vorbis VBR quality ([-1, 10], default 4)
  -c, --concurrency  max parallel sample encodes
                       default: hardwareConcurrency or 4
  -r, --recompress   re-encode samples that are already compressed
                     (SF3 input), instead of copying them through as-is
                       default: false`);
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
