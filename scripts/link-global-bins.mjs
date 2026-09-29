// Recreate the global CLI launchers that npm installs as symlinks.
//
// npm links /usr/local/bin/dsh and /usr/local/bin/pnpm into
// /usr/local/lib/node_modules. Copying them out of a build stage lands a real
// file in /usr/local/bin instead of a link, and Node's ESM resolver then only
// looks for node_modules under /usr/local/bin — it never consults the global
// package root, because that fallback is a CommonJS-only concept. dsh's entry
// point statically imports @deepseek-ai/dsh-app-boot, so it died at startup
// with ERR_MODULE_NOT_FOUND and the container restarted forever.
//
// This runs in the runtime stage, after the global package tree has been
// copied, and rebuilds each launcher as an absolute symlink so the module that
// actually executes always lives inside the global node_modules tree. It fails
// loudly if a bin entry is missing or if the tree cannot be resolved.
import fs from "node:fs";
import path from "node:path";

const root = "/usr/local/lib/node_modules";
const binDir = "/usr/local/bin";

// Only the commands this image actually invokes are linked.
const wanted = [
  ["@deepseek-ai/dsh", ["dsh"]],
  ["pnpm", ["pnpm"]],
];

for (const [name, commands] of wanted) {
  const packageDir = path.join(root, name);
  const manifestPath = path.join(packageDir, "package.json");
  const { bin } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = typeof bin === "string" ? { [name.split("/").pop()]: bin } : bin || {};

  for (const command of commands) {
    const target = entries[command];
    if (!target) {
      throw new Error(`${name} has no bin entry for "${command}"`);
    }
    const to = path.resolve(packageDir, target);
    if (!fs.existsSync(to)) {
      throw new Error(`bin target does not exist: ${to}`);
    }
    const from = path.join(binDir, command);
    fs.rmSync(from, { force: true });
    fs.symlinkSync(to, from);
    if (!fs.lstatSync(from).isSymbolicLink()) {
      throw new Error(`${from} is not a symlink`);
    }
    console.log(`linked ${from} -> ${to}`);
  }
}

// Proof that the copied tree is intact: this file sits in /usr/local/lib, so a
// successful ESM resolution here is exactly what dsh does from its own package
// directory. Throws ERR_MODULE_NOT_FOUND if the global tree is broken.
const resolved = import.meta.resolve("@deepseek-ai/dsh-app-boot");
console.log(`resolved @deepseek-ai/dsh-app-boot -> ${resolved}`);
