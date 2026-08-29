# @marmooo/sf2-to-sf3

Convert SF2 to SF3.

## CLI

```
deno run -RW --allow-run \
  cli.ts input.sf2 output.sf3 [bitsPerHz] [concurrency]
```

## Installation

### Deno

```
deno install -fr -A npm:@marmooo/sf2-to-sf3 -g
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
  bitsPerHz: 4, // compression/quality — see src/encoder.ts
  concurrency: 4, // samples encoded at once — forwarded to write()
  encode: myEncoder, // use your own SF3Encoder instead of the default
});
```

By default `sf2ToSf3()` shells out to `@mediabunny/server` (FFmpeg/libvorbis
bindings) in a subprocess per sample — see `src/encoder.ts` and
`src/_vorbis-worker.ts` for why a subprocess is used rather than calling
mediabunny in-process. If you pass your own `encode`, none of that runs: no
subprocess, no `node_modules`, no native bindings — e.g. in a browser you'd
likely want to call mediabunny directly instead, since the subprocess workaround
here is specific to running FFmpeg-backed encoders server-side.

## License

MIT
