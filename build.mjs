// esbuild bundle → main.js (the plugin's JS entry). The core loader imports the entry as a blob
// URL, which cannot resolve relative imports, so the JS half must be bundled into one file.
// The Rust service half builds separately (cargo) and is untouched by this.
import { build, context } from "esbuild";

const opts = {
  entryPoints: ["js/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[workflow] watching js → main.js …");
} else {
  await build(opts);
  console.log("[workflow] built main.js");
}
