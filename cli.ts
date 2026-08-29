import { parse } from "@marmooo/soundfont";
import { sf2ToSf3 } from "./src/mod.ts";

const [inputPath, outputPath, bitsPerHzArg, concurrencyArg] = Deno.args;
if (!inputPath || !outputPath) {
  console.error(
    "usage: sf2-to-sf3 <input.sf2> <output.sf3> [bitsPerHz] [concurrency]",
  );
  Deno.exit(1);
}

const file = Deno.readFileSync(inputPath);
const soundFont = parse(file);

const sf3Bytes = await sf2ToSf3(soundFont, {
  bitsPerHz: bitsPerHzArg ? Number(bitsPerHzArg) : undefined,
  concurrency: concurrencyArg ? Number(concurrencyArg) : undefined,
});

Deno.writeFileSync(outputPath, sf3Bytes);
console.log(`wrote ${outputPath} (${sf3Bytes.byteLength} bytes)`);
