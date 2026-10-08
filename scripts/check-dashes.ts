// House style: no em or en dashes anywhere. Exits 1 and lists every hit. npx tsx scripts/check-dashes.ts
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "server", "shared", "scripts", "docs", "README.md", "index.html"];
const EXT = /\.(ts|tsx|js|cjs|mjs|css|html|md|json|txt)$/;
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`); // en and em dash, built from codes so this file passes itself
const hits: string[] = [];

function scan(p: string) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== "node_modules") scan(path.join(p, e));
    return;
  }
  if (!EXT.test(p)) return;
  fs.readFileSync(p, "utf8")
    .split("\n")
    .forEach((line, i) => DASH.test(line) && hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`));
}

ROOTS.forEach(scan);
if (hits.length) {
  console.error(`${hits.length} em/en dash${hits.length === 1 ? "" : "es"} found:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("no em or en dashes");
