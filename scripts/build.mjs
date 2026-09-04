import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle } from "./bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await createBundle(root);
await writeFile(path.join(root, "dist", "index.js"), bundle, "utf8");
process.stdout.write(`Built dist/index.js (${Buffer.byteLength(bundle)} bytes)\n`);
