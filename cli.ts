import { parse } from "@marmooo/soundfont";
import { sf2ToSf3 } from "./src/mod.ts";

// --recompress is a flag and can appear anywhere; strip it out first so the
// remaining args stay purely positional.
const args = Deno.args.filter((a) => a !== "--recompress");
const recompress = args.length !== Deno.args.length;
const [inputPath, outputPath, qualityArg, concurrencyArg] = args;

if (!inputPath || !outputPath) {
  console.error(
    "usage: sf2-to-sf3 <input.sf2|sf3> <output.sf3> [quality] [concurrency] [--recompress]",
  );
  console.error("");
  console.error(
    "  quality      - Vorbis VBR quality ([-1, 10], default 4)",
  );
  console.error(
    "  concurrency  - max parallel sample encodes.",
    "                  default: hardwareConcurrency or 4",
  );
  console.error(
    "  --recompress - also re-encode samples that are already compressed",
    "                  (SF3 input), instead of copying them through as-is",
  );
  Deno.exit(1);
}

const file = Deno.readFileSync(inputPath);
const soundFont = parse(file);

const sf3Bytes = await sf2ToSf3(soundFont, {
  quality: qualityArg ? Number(qualityArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
  recompress,
});

Deno.writeFileSync(outputPath, sf3Bytes);
console.log(`wrote ${outputPath} (${sf3Bytes.byteLength} bytes)`);
