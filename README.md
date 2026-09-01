# @marmooo/sf2-to-sf3

Convert SF2 to SF3.

## CLI

```
sf2-to-sf3 input.sf2 output.sf3 [quality] [concurrency]
```

`quality` is Vorbis VBR quality (−1..10, default 4).\
`concurrency` is how many samples encode at once (default: hardwareConcurrency
or 4).

## Installation

### Deno

```
deno install -fr -RW -g npm:@marmooo/sf2-to-sf3 --name sf2-to-sf3
```

### Node

```
npm install @marmooo/sf2-to-sf3 -g
```

## As a function

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
  quality: 4, // Vorbis VBR −1..10 — see src/encoder.ts
  concurrency: 4, // samples encoded at once — also sizes the worker pool
  encode: myEncoder, // use your own SF3Encoder instead of the default
});
```

By default `sf2ToSf3()` encodes with
[wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders)
(libvorbis WASM) inside a pool of Workers / `worker_threads` — see
`src/encoder.ts` and `src/_wasm-encoder-worker.ts`. No native FFmpeg/node-av
bindings are required.

If you pass your own `encode`, the worker pool is not started.

## License

MIT
