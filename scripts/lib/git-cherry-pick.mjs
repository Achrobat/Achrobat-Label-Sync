import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Applies a merged pull request's commits to another branch with git on the runner and pushes the result to a
// new branch. The GitHub API has no cherry-pick, so this is the one place Label Sync runs git against a target
// repository. Only the commits being picked and the tip of the target branch are fetched (shallow), and no
// code from them is ever run. The token reaches git through GIT_CONFIG_* environment variables, never through
// the command line or the remote URL, so it cannot show up in error messages.

const MAX_REASON_LENGTH = 600;

function runGit(args, { cwd, env }) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function shorten(text) {
  const value = String(text ?? "").trim();
  return value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;
}

// remoteUrl is only overridden by tests, which point it at a local repository.
export function createGitCherryPicker({
  token,
  identity,
  gitHost = "github.com",
  remoteUrl = (repository) => `https://${gitHost}/${repository}.git`,
  log = console.log,
}) {
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${gitHost}/.extraheader`,
    GIT_CONFIG_VALUE_0: authHeader,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };

  // Returns { ok: true } once headBranch is pushed, or { ok: false, reason, conflicts } without pushing.
  // `count` commits ending at mergeCommitSha are picked; `mainline` is set for a merge commit.
  return async ({ repository, mergeCommitSha, count = 1, mainline = null, targetBranch, headBranch }) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-cherry-pick-"));
    const git = (args) => runGit(args, { cwd, env });

    try {
      for (const args of [
        ["init", "-q"],
        ["remote", "add", "origin", remoteUrl(repository)],
        ["fetch", "-q", "--no-tags", `--depth=${count + 1}`, "origin", mergeCommitSha],
        ["fetch", "-q", "--no-tags", "--depth=1", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/label-sync-target`],
        ["checkout", "-q", "-b", "label-sync-cherry-pick", "refs/remotes/origin/label-sync-target"],
      ]) {
        const result = await git(args);

        if (!result.ok) {
          return { ok: false, reason: `git ${args[0]} failed: ${shorten(result.stderr)}`, conflicts: [] };
        }
      }

      const pickArgs = mainline
        ? ["cherry-pick", "-x", "-m", String(mainline), mergeCommitSha]
        : count > 1
          ? ["cherry-pick", "-x", `${mergeCommitSha}~${count}..${mergeCommitSha}`]
          : ["cherry-pick", "-x", mergeCommitSha];
      const picked = await git(pickArgs);

      if (!picked.ok) {
        const conflicted = await git(["diff", "--name-only", "--diff-filter=U"]);
        const conflicts = conflicted.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
        await git(["cherry-pick", "--abort"]);
        const output = `${picked.stdout}\n${picked.stderr}`;
        const reason = conflicts.length > 0
          ? "the changes conflict with the target branch"
          : /empty|nothing to commit/i.test(output)
            ? "the changes are already on the target branch, so there was nothing to pick"
            : `git cherry-pick failed: ${shorten(picked.stderr || picked.stdout)}`;
        return { ok: false, reason, conflicts };
      }

      const pushed = await git(["push", "-q", "origin", `HEAD:refs/heads/${headBranch}`]);

      if (!pushed.ok) {
        const workflowHint = /workflow/i.test(pushed.stderr)
          ? " The token needs the Workflows permission to push changes to .github/workflows."
          : "";
        return { ok: false, reason: `git push failed: ${shorten(pushed.stderr)}${workflowHint}`, conflicts: [] };
      }

      log(`Pushed ${headBranch} to ${repository}.`);
      return { ok: true };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}
