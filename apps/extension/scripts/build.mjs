import { cp, mkdir, rm, watch } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build as bundle } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");
const source = path.join(root, "src");

async function build() {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
  await cp(path.join(source, "popup.html"), path.join(output, "popup.html"));
  await cp(path.join(source, "popup.css"), path.join(output, "popup.css"));
  await bundle({
    entryPoints: [
      path.join(source, "background.js"),
      path.join(source, "content.js"),
      path.join(source, "popup.js"),
    ],
    bundle: true,
    format: "esm",
    target: "chrome116",
    outdir: output,
    entryNames: "[name]",
    sourcemap: true,
    logLevel: "silent",
  });
  console.log(`Built unpacked extension at ${output}`);
}

await build();

if (process.argv.includes("--watch")) {
  console.log("Watching extension source files…");
  const watcher = watch(root, { recursive: true });
  for await (const event of watcher) {
    if (event.filename?.startsWith("dist")) continue;
    await build();
  }
}
