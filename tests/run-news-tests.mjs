/**
 * Test runner for the crypto-news core (no new dependencies):
 * transpiles lib/agent/news-core.ts with the project's TypeScript into a
 * temp dir, copies the test file next to it, and runs node --test.
 * Usage: node tests/run-news-tests.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "news-core-test-"));

execFileSync(
  "npx",
  [
    "tsc", "lib/agent/news-core.ts",
    "--outDir", out,
    "--module", "nodenext",
    "--target", "es2022",
    "--moduleResolution", "nodenext",
    "--skipLibCheck",
  ],
  { cwd: root, stdio: "inherit" }
);
copyFileSync(join(root, "tests/news-core.test.mjs"), join(out, "news-core.test.mjs"));
execFileSync("node", ["--test", join(out, "news-core.test.mjs")], { stdio: "inherit" });
