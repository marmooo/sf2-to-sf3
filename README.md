# @marmooo/sf2-to-sf3

Convert SF2 to SF3.

## Installation

### Deno

```
deno install -fr -RW -g npm:@marmooo/sf2-to-sf3 --name sf2-to-sf3
```

### Node

```
npm install @marmooo/sf2-to-sf3 -g
```

## Usage

```js
import { parse } from "@marmooo/soundfont";
import { sf2ToSf3 } from "@marmooo/sf2-to-sf3";

const file = Deno.readFileSync("soundfont.sf2");
const soundFont = parse(file);

const output = await sf2ToSf3(soundFont);
Deno.writeFileSync("output.sf3", output);
```

Options:

```js
await sf2ToSf3(soundFont, {
  quality: 4, // Vorbis VBR [-1, 10]: see src/encoder.ts
  concurrency: 4, // samples encoded at once: also sizes the worker pool
  encode: myEncoder, // use your own SF3Encoder instead of the default
});
```

By default `sf2ToSf3()` encodes with
[wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders)
(libvorbis WASM) inside a pool of Workers / `worker_threads` - see
`src/encoder.ts` and `src/_wasm-encoder-worker.ts`. No native FFmpeg/node-av
bindings are required.

If you pass your own `encode`, the worker pool is not started.

### CLI

```
Usage: sf2-to-sf3 <input.sf2|sf3> <output.sf3> [options]

Convert SF2 to SF3.

Options:
  -V, --version      show version
  -q, --quality      Vorbis VBR quality ([-1, 10], default 4)
  -c, --concurrency  max parallel sample encodes
                     default: hardwareConcurrency or 4
  -r, --recompress   re-encode samples that are already compressed
                     (SF3 input), instead of copying them through as-is
                     default: false
  -h, --help         show this help
```

## License

MIT
