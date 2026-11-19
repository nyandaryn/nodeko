/**
 * Сборка самодостаточных бинарей агента (Bun --compile) под linux x64 и arm64.
 *   bun scripts/build-agent.ts
 * → dist/agent/nodeko-agent-linux-{x64,arm64} + dist/agent/manifest.json (версия, sha256).
 *
 * x64 собирается под baseline-таргет (без AVX2) — агенту скорость не нужна, а запуститься он должен
 * на любом VPS.
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_VERSION } from "../src/shared/protocol.ts";

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "dist/agent");
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { arch: "x64", target: "bun-linux-x64-baseline" },
  { arch: "arm64", target: "bun-linux-arm64" },
] as const;

async function sha256File(file: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(file).stream();
  for await (const chunk of stream) h.update(chunk);
  return h.digest("hex");
}

const sha: Record<string, string> = {};
for (const t of targets) {
  const outfile = path.join(outDir, `nodeko-agent-linux-${t.arch}`);
  const tmp = `${outfile}.tmp`;
  const proc = Bun.spawn(
    ["bun", "build", "--compile", "--minify", "--sourcemap=none", `--target=${t.target}`, "src/agent/main.ts", "--outfile", tmp],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`сборка ${t.arch} упала (код ${code})`);
    process.exit(1);
  }
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, outfile);
  sha[t.arch] = await sha256File(outfile);
  const size = fs.statSync(outfile).size;
  console.log(`✓ ${path.relative(root, outfile)}  ${(size / 1e6).toFixed(1)} MB  sha256 ${sha[t.arch]}`);
}

const manifest = { version: AGENT_VERSION, sha256: { x64: sha.x64!, arm64: sha.arm64! }, builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ dist/agent/manifest.json (agent ${AGENT_VERSION})`);
