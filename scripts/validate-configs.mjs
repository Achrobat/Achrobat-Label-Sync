import path from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();

function runValidation(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(workspaceRoot, "scripts", scriptName), "--validate-only"],
      { stdio: "inherit" },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${scriptName} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function main() {
  await runValidation("sync-labels.mjs");
  await runValidation("reverse-config-label-sync.mjs");
  await runValidation("remove-labels.mjs");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
