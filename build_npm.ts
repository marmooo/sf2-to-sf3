import { build, emptyDir } from "@deno/dnt";

await emptyDir("./npm");

await build({
  entryPoints: [
    "./src/mod.ts",
    {
      kind: "bin",
      name: "sf2-to-sf3",
      path: "./cli.ts",
    },
  ],
  outDir: "./npm",
  shims: {
    deno: true,
  },
  package: {
    name: "@marmooo/sf2-to-sf3",
    version: "0.0.0",
    description: "Convert SF2 to SF3.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/marmooo/sf2-to-sf3.git",
    },
    bugs: {
      url: "https://github.com/marmooo/sf2-to-sf3/issues",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
