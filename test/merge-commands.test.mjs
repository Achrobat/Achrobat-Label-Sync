import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandsConfig } from "../scripts/lib/config-validation.mjs";
import { branchMatchesPattern, isValidRefName } from "../scripts/lib/command-utils.mjs";
import {
  acknowledgeMergeCommand,
  planCommitsToPick,
  runMergeCommands,
} from "../scripts/lib/merge-commands.mjs";
import { comment, createFakeGithub, firstPage, httpError } from "./helpers/fake-github.mjs";

const BOT = "label-sync[bot]";
const SHA = "abc123";
const config = validateCommandsConfig({
  cherryPick: { label: "Backport", branches: ["release/**", "stable"], allowedUsers: "teams/maintainers, Alice" },
  release: { allowedUsers: "Alice, Rel" },
}, { labelTestWorkflowConfig: {} });

// Org/repo#5, merged into main (the default branch) as SHA unless told otherwise.
function createGithub({
  merged = true,
  state = merged ? "closed" : "open",
  labels = ["Backport", "Bug"],
  comments = [],
  description = { body: "", editor: null, author: "Author" },
  baseRef = "main",
  branches = ["main", "release/1.7", "stable"],
  tags = {},
  releases = {},
  existingPulls = [],
  parents = 1,
  commitMessage = "Fix thing (#5)",
  prCommits = [{ commit: { message: "Fix thing" } }],
} = {}) {
  const recorded = { posted: [], reactions: [], createdPulls: [], createdReleases: [], addedLabels: [], assignees: [] };
  const fake = createFakeGithub([
    ["GET", /^\/repos\/Org\/repo\/pulls\/5$/, () => ({
      number: 5,
      title: "Fix thing",
      state,
      merged_at: merged ? "2026-10-02T00:00:00Z" : null,
      merge_commit_sha: merged ? SHA : null,
      commits: prCommits.length,
      labels: labels.map((name) => ({ name })),
      base: { ref: baseRef, repo: { default_branch: "main" } },
    })],
    ["GET", /^\/repos\/Org\/repo\/pulls\/5\/commits$/, firstPage(prCommits)],
    ["GET", /^\/repos\/Org\/repo\/issues\/5\/comments$/, firstPage(comments)],
    ["POST", /^\/graphql$/, ({ body }) => {
      assert.deepEqual(body.variables, { owner: "Org", name: "repo", number: 5 });
      const actor = (login) => (login ? { __typename: login.endsWith("[bot]") ? "Bot" : "User", login } : null);
      return {
        data: {
          repository: {
            pullRequest: {
              body: description.body,
              createdAt: "2026-10-01T00:00:00Z",
              lastEditedAt: description.editor ? (description.editedAt ?? "2026-10-01T12:00:00Z") : null,
              author: actor(description.author),
              editor: actor(description.editor),
            },
          },
        },
      };
    }],
    ["GET", /^\/repos\/Org\/repo\/branches\/(.+)$/, ({ match }) => {
      if (!branches.includes(decodeURIComponent(match[1]))) {
        throw httpError(404);
      }
      return {};
    }],
    ["GET", /^\/repos\/Org\/repo\/pulls$/, ({ query }) => existingPulls.filter((pull) => `Org:${pull.head}` === query.get("head"))],
    ["GET", /^\/repos\/Org\/repo\/commits\/abc123$/, () => ({
      parents: Array.from({ length: parents }, (_, index) => ({ sha: `p${index}` })),
      commit: { message: commitMessage },
    })],
    ["POST", /^\/repos\/Org\/repo\/pulls$/, ({ body }) => {
      recorded.createdPulls.push(body);
      return { number: 99 };
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/99\/labels$/, ({ body }) => {
      recorded.addedLabels.push(...body.labels);
      return [];
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/99\/assignees$/, ({ body }) => {
      recorded.assignees.push(...body.assignees);
      return {};
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/5\/comments$/, ({ body }) => {
      recorded.posted.push(body.body);
      return {};
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/comments\/(\d+)\/reactions$/, ({ match, body }) => {
      recorded.reactions.push(`${match[1]}:${body.content}`);
      return {};
    }],
    ["GET", /^\/repos\/Org\/repo\/git\/ref\/tags\/(.+)$/, ({ match }) => {
      const tag = decodeURIComponent(match[1]);
      if (!tags[tag]) {
        throw httpError(404);
      }
      return { object: { sha: tags[tag] } };
    }],
    ["GET", /^\/repos\/Org\/repo\/releases\/tags\/(.+)$/, ({ match }) => {
      const found = releases[decodeURIComponent(match[1])];
      if (!found) {
        throw httpError(404);
      }
      return found;
    }],
    ["POST", /^\/repos\/Org\/repo\/releases$/, ({ body }) => {
      recorded.createdReleases.push(body);
      return { html_url: `https://github.com/Org/repo/releases/tag/${body.tag_name}` };
    }],
  ]);
  return { ...fake, recorded };
}

function createCherryPicker(result = { ok: true }) {
  const calls = [];
  const cherryPick = async (options) => {
    calls.push(options);
    return result;
  };
  return { calls, cherryPick };
}

const isTeamMember = async (slug, login) => slug === "maintainers" && login === "Maya";

async function merge(github, cherryPick = createCherryPicker().cherryPick) {
  return runMergeCommands({
    request: github.request,
    config,
    repository: "Org/repo",
    number: 5,
    isTeamMember,
    isAutomationActor: async (login) => login === BOT,
    cherryPick,
    log: () => {},
  });
}

async function acknowledge(github, command, login, body) {
  return acknowledgeMergeCommand({
    request: github.request,
    config,
    command,
    repository: "Org/repo",
    number: 5,
    issue: { pull_request: {} },
    comment: comment(1, login, body),
    commands: [{ name: command, args: body.trim().split(/\s+/).slice(1) }],
    isTeamMember,
    log: () => {},
  });
}

test("branch patterns and ref names", () => {
  assert.ok(branchMatchesPattern("release/1.7", "release/**"));
  assert.ok(branchMatchesPattern("release/2/hotfix", "release/**"));
  assert.ok(branchMatchesPattern("release/1.7", "release/*"));
  assert.ok(!branchMatchesPattern("release/2/hotfix", "release/*"));
  assert.ok(!branchMatchesPattern("prerelease/1", "release/**"));
  assert.ok(!branchMatchesPattern("release-1", "release.1"));
  assert.ok(isValidRefName("v2.8.0"));
  assert.ok(isValidRefName("release/1.7"));
  for (const bad of ["", "-x", "a..b", "a b", "a~1", "a:b", "x.lock", "x/", "/x", "a@{1}", "a\\b"]) {
    assert.ok(!isValidRefName(bad), bad);
  }
});

test("cherryPick and release settings are validated", () => {
  assert.deepEqual(config.cherryPick.branches, ["release/**", "stable"]);
  const empty = validateCommandsConfig({ cherryPick: {}, release: {} }, { labelTestWorkflowConfig: {} });
  assert.equal(empty.cherryPick, null);
  assert.equal(empty.release, null);
  assert.throws(() => validateCommandsConfig({ cherryPick: { branches: "x", allowedUsers: "A" } }, { labelTestWorkflowConfig: {} }), /needs a non-empty "label"/);
  assert.throws(() => validateCommandsConfig({ cherryPick: { label: "B", allowedUsers: "A" } }, { labelTestWorkflowConfig: {} }), /needs "branches"/);
  assert.throws(() => validateCommandsConfig({ cherryPick: { label: "B", branches: "x" } }, { labelTestWorkflowConfig: {} }), /allowedUsers must be/);
  assert.throws(() => validateCommandsConfig({ cherryPick: { label: "B", branches: ["a b"], allowedUsers: "A" } }, { labelTestWorkflowConfig: {} }), /not a valid branch name/);
  assert.throws(() => validateCommandsConfig({ release: { allowedUsers: "teams/" } }, { labelTestWorkflowConfig: {} }), /team slug/);
});

test("a valid /cherry-pick gets a thumbs up and nothing else", async () => {
  const github = createGithub({ merged: false });

  const result = await acknowledge(github, "cherry-pick", "Maya", "/cherry-pick release/1.7");

  assert.deepEqual(result, { accepted: true, merged: false });
  assert.deepEqual(github.recorded.reactions, ["1:+1"]);
  assert.deepEqual(github.recorded.posted, []);
});

test("an invalid /cherry-pick from an allowed person is explained", async () => {
  const github = createGithub({ merged: false });

  await acknowledge(github, "cherry-pick", "Alice", "/cherry-pick feature/x");
  await acknowledge(github, "cherry-pick", "Alice", "/cherry-pick release/9.9");
  await acknowledge(github, "cherry-pick", "Alice", "/cherry-pick");

  assert.deepEqual(github.recorded.reactions, ["1:-1", "1:-1", "1:-1"]);
  assert.match(github.recorded.posted[0], /@Alice[\s\S]*`feature\/x` is not a branch you can cherry-pick into \(allowed: `release\/\*\*`, `stable`\)/);
  assert.match(github.recorded.posted[1], /`release\/9\.9` does not exist in Org\/repo/);
  assert.match(github.recorded.posted[2], /no branch was given/);
});

test("people not allowed get a thumbs down and no reply", async () => {
  const github = createGithub({ merged: false });

  const result = await acknowledge(github, "release", "Mallory", "/release v1.0.0");

  assert.deepEqual(result, { ignored: "not-allowed" });
  assert.deepEqual(github.recorded.reactions, ["1:-1"]);
  assert.deepEqual(github.recorded.posted, []);
});

test("/release is checked against existing tags and the default branch when it is posted", async () => {
  const github = createGithub({ merged: false, tags: { "v1.0.0": "old" } });
  await acknowledge(github, "release", "Alice", "/release v1.0.0");
  assert.match(github.recorded.posted[0], /the tag `v1\.0\.0` already exists/);

  const offDefault = createGithub({ merged: false, baseRef: "release/1.7" });
  await acknowledge(offDefault, "release", "Alice", "/release v2.0.0");
  assert.match(offDefault.recorded.posted[0], /releases are only made from pull requests into `main`/);

  const fine = createGithub({ merged: false });
  assert.deepEqual(await acknowledge(fine, "release", "Rel", "/release v2.0.0"), { accepted: true, merged: false });
});

test("a command on a pull request that already merged says so, so the merge work runs right away", async () => {
  const github = createGithub();

  assert.deepEqual(await acknowledge(github, "cherry-pick", "Alice", "/cherry-pick stable"), { accepted: true, merged: true });
});

test("nothing happens for a pull request that did not merge", async () => {
  const github = createGithub({ merged: false, state: "closed", comments: [comment(1, "Alice", "/cherry-pick stable\n/release v1")] });
  const picker = createCherryPicker();

  const outcome = await merge(github, picker.cherryPick);

  assert.equal(outcome.merged, false);
  assert.deepEqual(picker.calls, []);
  assert.deepEqual(github.writes, []);
});

test("a labeled pull request is cherry-picked into each requested branch once it merges", async () => {
  const github = createGithub({
    comments: [
      comment(1, "Alice", "/cherry-pick release/1.7", { createdAt: "2026-10-01T01:00:00Z" }),
      comment(2, "Maya", "/cherry-pick release/1.7\n/cherry-pick stable", { createdAt: "2026-10-01T02:00:00Z" }),
      comment(3, "Mallory", "/cherry-pick release/1.7"),
      comment(4, BOT, "/cherry-pick release/1.7", { type: "Bot" }),
    ],
  });
  const picker = createCherryPicker();

  const outcome = await merge(github, picker.cherryPick);

  assert.deepEqual(picker.calls, [
    { repository: "Org/repo", mergeCommitSha: SHA, count: 1, mainline: null, targetBranch: "release/1.7", headBranch: "cherry-pick/5-to-release/1.7" },
    { repository: "Org/repo", mergeCommitSha: SHA, count: 1, mainline: null, targetBranch: "stable", headBranch: "cherry-pick/5-to-stable" },
  ]);
  assert.deepEqual(github.recorded.createdPulls[0], {
    title: "[release/1.7] Fix thing",
    head: "cherry-pick/5-to-release/1.7",
    base: "release/1.7",
    body: `Cherry-pick of #5 into \`release/1.7\`, requested by @Alice @Maya.\n\nOpened by Label Sync after #5 merged as ${SHA}.`,
  });
  // Every label except the cherry-pick label carries over, and the people who asked are assigned.
  assert.deepEqual(github.recorded.addedLabels, ["Bug", "Bug"]);
  assert.deepEqual(github.recorded.assignees, ["Alice", "Maya", "Maya"]);
  assert.match(github.recorded.posted[0], /\*\*Cherry-pick\*\*\n\n@Alice @Maya opened #99 to cherry-pick this into `release\/1\.7`\./);
  assert.equal(outcome.cherryPicks.length, 2);
});

test("without the label at merge time nothing is cherry-picked, and the people who asked are told", async () => {
  const github = createGithub({ labels: ["Bug"], comments: [comment(1, "Alice", "/cherry-pick stable")] });
  const picker = createCherryPicker();

  const outcome = await merge(github, picker.cherryPick);

  assert.equal(outcome.labelMissing, true);
  assert.deepEqual(picker.calls, []);
  assert.match(github.recorded.posted[0], /@Alice this pull request merged without the `Backport` label, so it was not cherry-picked into `stable`\./);
});

test("a conflict fails the run and asks the person to cherry-pick by hand", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/cherry-pick stable")] });
  const picker = createCherryPicker({ ok: false, reason: "the changes conflict with the target branch", conflicts: ["src/a.java"] });

  await assert.rejects(merge(github, picker.cherryPick), /cherry-pick into stable: the changes conflict/);

  assert.deepEqual(github.recorded.createdPulls, []);
  assert.match(github.recorded.posted[0], /@Alice Label Sync could not cherry-pick this pull request into `stable`: the changes conflict with the target branch\. Conflicting files: `src\/a\.java`\.\n\nPlease cherry-pick it by hand\./);
});

test("a cherry-pick that was already opened is not repeated", async () => {
  const github = createGithub({
    comments: [comment(1, "Alice", "/cherry-pick stable")],
    existingPulls: [{ number: 77, head: "cherry-pick/5-to-stable" }],
  });
  const picker = createCherryPicker();

  await merge(github, picker.cherryPick);

  assert.deepEqual(picker.calls, []);
  assert.deepEqual(github.writes.filter((write) => write.path !== "/graphql"), []);
});

test("a target branch deleted before the merge is reported", async () => {
  const github = createGithub({ branches: ["main"], comments: [comment(1, "Alice", "/cherry-pick stable")] });

  await assert.rejects(merge(github), /`stable` does not exist/);
  assert.match(github.recorded.posted[0], /could not cherry-pick this pull request into `stable`: `stable` does not exist/);
});

test("the commits to pick follow the merge method", async () => {
  const pullRequest = { number: 5, merge_commit_sha: SHA, commits: 3 };
  const threeCommits = [{ commit: { message: "One" } }, { commit: { message: "Two" } }, { commit: { message: "Three" } }];

  const mergeCommit = createGithub({ parents: 2, prCommits: threeCommits });
  assert.deepEqual(await planCommitsToPick(mergeCommit.request, "Org/repo", pullRequest), { mergeCommitSha: SHA, count: 1, mainline: 1, method: "merge" });

  const rebase = createGithub({ commitMessage: "Three", prCommits: threeCommits });
  assert.deepEqual(await planCommitsToPick(rebase.request, "Org/repo", pullRequest), { mergeCommitSha: SHA, count: 3, mainline: null, method: "rebase" });

  const squash = createGithub({ commitMessage: "Fix thing (#5)\n\n* One\n* Two\n* Three", prCommits: threeCommits });
  assert.deepEqual(await planCommitsToPick(squash.request, "Org/repo", pullRequest), { mergeCommitSha: SHA, count: 1, mainline: null, method: "squash" });
});

test("/release creates a release on the merge commit", async () => {
  const github = createGithub({ comments: [comment(1, "Alice", "/release v2.8.0")] });

  await merge(github);

  assert.deepEqual(github.recorded.createdReleases, [{
    tag_name: "v2.8.0",
    target_commitish: SHA,
    name: "v2.8.0",
    generate_release_notes: true,
    draft: false,
    prerelease: false,
    make_latest: "true",
  }]);
  assert.equal(github.recorded.posted[0], "**Release**\n\n@Alice released [v2.8.0](https://github.com/Org/repo/releases/tag/v2.8.0).");
});

test("/release in the description counts for whoever edited it last", async () => {
  const allowed = createGithub({ description: { body: "Fixes stuff.\n\n/release v3.0.0\n", author: "Mallory", editor: "Rel" } });
  await merge(allowed);
  assert.equal(allowed.recorded.createdReleases[0].tag_name, "v3.0.0");
  assert.match(allowed.recorded.posted[0], /@Rel released/);

  const notAllowed = createGithub({ description: { body: "/release v3.0.0", author: "Alice", editor: "Mallory" } });
  await merge(notAllowed);
  assert.deepEqual(notAllowed.recorded.createdReleases, []);

  const neverEdited = createGithub({ description: { body: "/release v3.0.0", author: "Alice", editor: null } });
  await merge(neverEdited);
  assert.equal(neverEdited.recorded.createdReleases[0].tag_name, "v3.0.0");

  const byBot = createGithub({ description: { body: "/release v3.0.0", author: "Alice", editor: "renovate[bot]" } });
  await merge(byBot);
  assert.deepEqual(byBot.recorded.createdReleases, []);
});

test("the latest /release wins", async () => {
  const github = createGithub({
    description: { body: "/release v1.0.0", author: "Alice", editor: "Alice", editedAt: "2026-10-01T03:00:00Z" },
    comments: [
      comment(1, "Alice", "/release v0.9.0", { createdAt: "2026-10-01T02:00:00Z" }),
      comment(2, "Rel", "/release v1.1.0", { createdAt: "2026-10-01T04:00:00Z" }),
    ],
  });

  await merge(github);

  assert.deepEqual(github.recorded.createdReleases.map((release) => release.tag_name), ["v1.1.0"]);
});

test("an existing tag cancels the release and mentions the person who asked", async () => {
  const github = createGithub({ tags: { "v2.8.0": "other" }, comments: [comment(1, "Alice", "/release v2.8.0")] });

  await assert.rejects(merge(github), /release v2\.8\.0: the tag `v2\.8\.0` already exists/);

  assert.deepEqual(github.recorded.createdReleases, []);
  assert.equal(github.recorded.posted[0], "**Release**\n\n@Alice the tag `v2.8.0` already exists, so no release was created.");
});

test("a rerun after the release was made does nothing", async () => {
  const github = createGithub({
    tags: { "v2.8.0": SHA },
    releases: { "v2.8.0": { html_url: "x" } },
    comments: [comment(1, "Alice", "/release v2.8.0")],
  });

  const outcome = await merge(github);

  assert.equal(outcome.release.skipped, "exists");
  assert.deepEqual(github.writes.filter((write) => write.path !== "/graphql"), []);
});

test("a pull request merged into another branch is not released", async () => {
  const github = createGithub({ baseRef: "release/1.7", comments: [comment(1, "Alice", "/release v1.7.1")] });

  await assert.rejects(merge(github), /only made from pull requests into `main`/);
  assert.deepEqual(github.recorded.createdReleases, []);
});
