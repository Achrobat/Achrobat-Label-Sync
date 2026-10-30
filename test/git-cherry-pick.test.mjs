import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGitCherryPicker } from "../scripts/lib/git-cherry-pick.mjs";

// Runs the real git cherry-pick against a local bare repository standing in for GitHub.

const identity = { name: "label-sync[bot]", email: "1+label-sync[bot]@users.noreply.github.com" };
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@example.com",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function setUp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "label-sync-git-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const write = (file, text) => fs.writeFile(path.join(work, file), text);
  const commit = async (file, text, message) => {
    await write(file, text);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };

  git(root, "init", "-q", "--bare", origin);
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  await commit("a.txt", "one\ntwo\nthree\n", "Initial");
  git(work, "branch", "release/1.7");

  const picker = createGitCherryPicker({
    token: "not-a-real-token",
    identity,
    remoteUrl: () => `file://${origin}`,
    log: () => {},
  });
  const show = (ref, file) => git(origin, "show", `${ref}:${file}`);
  const push = () => git(work, "push", "-q", "origin", "main", "release/1.7");
  const cleanUp = () => fs.rm(root, { recursive: true, force: true });

  return { git, work, origin, commit, picker, show, push, cleanUp };
}

test("a squash-merged commit is picked onto the target branch and pushed to a new branch", async () => {
  const repo = await setUp();

  try {
    await repo.commit("b.txt", "new file\n", "Other work on release");
    repo.git(repo.work, "checkout", "-q", "release/1.7");
    await repo.commit("c.txt", "release only\n", "Release fix");
    repo.git(repo.work, "checkout", "-q", "main");
    const sha = await repo.commit("a.txt", "one\nTWO\nthree\n", "Fix thing (#5)");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 1, targetBranch: "release/1.7", headBranch: "cherry-pick/5-to-release/1.7" });

    assert.deepEqual(result, { ok: true });
    assert.equal(repo.show("cherry-pick/5-to-release/1.7", "a.txt"), "one\nTWO\nthree");
    assert.equal(repo.show("cherry-pick/5-to-release/1.7", "c.txt"), "release only");
    const log = repo.git(repo.origin, "log", "-1", "--format=%an|%cn|%B", "cherry-pick/5-to-release/1.7");
    assert.match(log, /^Dev\|label-sync\[bot\]\|Fix thing \(#5\)/);
    assert.match(log, new RegExp(`cherry picked from commit ${sha}`));
  } finally {
    await repo.cleanUp();
  }
});

test("a rebase merge picks every commit of the pull request", async () => {
  const repo = await setUp();

  try {
    await repo.commit("x.txt", "1\n", "One");
    const sha = await repo.commit("y.txt", "2\n", "Two");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 2, targetBranch: "release/1.7", headBranch: "pick" });

    assert.deepEqual(result, { ok: true });
    assert.equal(repo.show("pick", "x.txt"), "1");
    assert.equal(repo.show("pick", "y.txt"), "2");
  } finally {
    await repo.cleanUp();
  }
});

test("a merge commit is picked against its first parent", async () => {
  const repo = await setUp();

  try {
    repo.git(repo.work, "checkout", "-q", "-b", "feature");
    await repo.commit("f.txt", "feature\n", "Feature");
    repo.git(repo.work, "checkout", "-q", "main");
    await repo.commit("m.txt", "main\n", "Main moved on");
    repo.git(repo.work, "merge", "-q", "--no-ff", "-m", "Merge pull request #5", "feature");
    const sha = repo.git(repo.work, "rev-parse", "HEAD");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 1, mainline: 1, targetBranch: "release/1.7", headBranch: "pick" });

    assert.deepEqual(result, { ok: true });
    assert.equal(repo.show("pick", "f.txt"), "feature");
    assert.throws(() => repo.show("pick", "m.txt"));
  } finally {
    await repo.cleanUp();
  }
});

test("a conflict is reported with the conflicting files and nothing is pushed", async () => {
  const repo = await setUp();

  try {
    repo.git(repo.work, "checkout", "-q", "release/1.7");
    await repo.commit("a.txt", "one\nrelease two\nthree\n", "Release change");
    repo.git(repo.work, "checkout", "-q", "main");
    const sha = await repo.commit("a.txt", "one\nmain two\nthree\n", "Main change");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 1, targetBranch: "release/1.7", headBranch: "pick" });

    assert.deepEqual(result, { ok: false, reason: "the changes conflict with the target branch", conflicts: ["a.txt"] });
    assert.throws(() => repo.git(repo.origin, "rev-parse", "--verify", "refs/heads/pick"));
  } finally {
    await repo.cleanUp();
  }
});

test("changes already on the target branch are reported instead of pushing an empty branch", async () => {
  const repo = await setUp();

  try {
    repo.git(repo.work, "checkout", "-q", "release/1.7");
    await repo.commit("a.txt", "one\nTWO\nthree\n", "Already fixed");
    repo.git(repo.work, "checkout", "-q", "main");
    const sha = await repo.commit("a.txt", "one\nTWO\nthree\n", "Fix thing");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 1, targetBranch: "release/1.7", headBranch: "pick" });

    assert.equal(result.ok, false);
    assert.match(result.reason, /already on the target branch/);
  } finally {
    await repo.cleanUp();
  }
});

test("a missing target branch fails before anything is picked", async () => {
  const repo = await setUp();

  try {
    const sha = await repo.commit("a.txt", "changed\n", "Change");
    repo.push();

    const result = await repo.picker({ repository: "Org/repo", mergeCommitSha: sha, count: 1, targetBranch: "nope", headBranch: "pick" });

    assert.equal(result.ok, false);
    assert.match(result.reason, /^git fetch failed/);
    assert.doesNotMatch(result.reason, /not-a-real-token/);
  } finally {
    await repo.cleanUp();
  }
});
