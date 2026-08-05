import assert from "node:assert/strict";
import test from "node:test";

import {
  LABEL_TEST_RUN_NOT_FOUND,
  LABEL_TEST_RUN_PENDING,
  REVIEW_SIGNAL_MISMATCH,
  rerunLabelTestForPullRequest,
  rerunLabelTestForReviewSignal,
  selectLatestCompletedLabelTestRun,
  selectLatestPendingLabelTestRun,
} from "../scripts/rerun-label-policy.mjs";

const FORK_HEAD = {
  pullRequestNumber: 42,
  headSha: "c0fc4575e40e05b22c6b607c297b139cc97019bf",
  headRef: "spike-assembler-recipies",
  headRepository: "Contributor/GT5-Unofficial",
};

function forkRun(overrides = {}) {
  return {
    id: 500,
    event: "pull_request_target",
    status: "completed",
    created_at: "2026-08-05T02:34:32Z",
    head_sha: FORK_HEAD.headSha,
    head_branch: FORK_HEAD.headRef,
    head_repository: { full_name: FORK_HEAD.headRepository },
    pull_requests: [],
    ...overrides,
  };
}

test("selectLatestCompletedLabelTestRun chooses the newest completed pull_request_target run for the PR", () => {
  const selected = selectLatestCompletedLabelTestRun([
    {
      id: 101,
      event: "pull_request_target",
      status: "completed",
      created_at: "2026-08-02T10:00:00Z",
      pull_requests: [{ number: 42 }],
    },
    {
      id: 102,
      event: "pull_request_review",
      status: "completed",
      created_at: "2026-08-02T10:05:00Z",
      pull_requests: [{ number: 42 }],
    },
    {
      id: 103,
      event: "pull_request_target",
      status: "in_progress",
      created_at: "2026-08-02T10:10:00Z",
      pull_requests: [{ number: 42 }],
    },
    {
      id: 104,
      event: "pull_request_target",
      status: "completed",
      created_at: "2026-08-02T10:15:00Z",
      pull_requests: [{ number: 7 }],
    },
    {
      id: 105,
      event: "pull_request_target",
      status: "completed",
      created_at: "2026-08-02T10:20:00Z",
      pull_requests: [{ number: 42 }],
    },
  ], 42);

  assert.equal(selected.id, 105);
});

test("selectLatestCompletedLabelTestRun returns null when no completed run belongs to the PR", () => {
  const selected = selectLatestCompletedLabelTestRun([
    {
      id: 201,
      event: "pull_request_target",
      status: "queued",
      created_at: "2026-08-02T10:00:00Z",
      pull_requests: [{ number: 42 }],
    },
    {
      id: 202,
      event: "pull_request_target",
      status: "completed",
      created_at: "2026-08-02T10:05:00Z",
      pull_requests: [{ number: 7 }],
    },
  ], 42);

  assert.equal(selected, null);
});

test("selectLatestCompletedLabelTestRun rejects invalid pull request numbers", () => {
  assert.throws(
    () => selectLatestCompletedLabelTestRun([], "not-a-number"),
    /pull request number must be a positive integer/i,
  );
});

test("selectLatestCompletedLabelTestRun matches a fork run by head commit when pull_requests is empty", () => {
  const selected = selectLatestCompletedLabelTestRun([forkRun()], FORK_HEAD);

  assert.equal(selected.id, 500);
});

test("selectLatestCompletedLabelTestRun ignores an identically named branch in a different fork", () => {
  const selected = selectLatestCompletedLabelTestRun([
    forkRun({
      id: 501,
      head_sha: "1111111111111111111111111111111111111111",
      head_repository: { full_name: "SomeoneElse/GT5-Unofficial" },
    }),
  ], FORK_HEAD);

  assert.equal(selected, null);
});

test("selectLatestCompletedLabelTestRun compares head repositories case-insensitively", () => {
  const selected = selectLatestCompletedLabelTestRun([
    forkRun({ id: 502, head_repository: { full_name: "contributor/gt5-unofficial" } }),
  ], FORK_HEAD);

  assert.equal(selected.id, 502);
});

test("selectLatestCompletedLabelTestRun falls back to head branch when the head commit has moved on", () => {
  const selected = selectLatestCompletedLabelTestRun([
    forkRun({
      id: 503,
      head_sha: "2222222222222222222222222222222222222222",
      created_at: "2026-08-04T02:34:32Z",
    }),
  ], FORK_HEAD);

  assert.equal(selected.id, 503);
});

test("selectLatestCompletedLabelTestRun prefers the reviewed head commit over a newer branch-only match", () => {
  const selected = selectLatestCompletedLabelTestRun([
    forkRun({
      id: 504,
      head_sha: "3333333333333333333333333333333333333333",
      created_at: "2026-08-06T02:34:32Z",
    }),
    forkRun({ id: 505, created_at: "2026-08-05T02:34:32Z" }),
  ], FORK_HEAD);

  assert.equal(selected.id, 505);
});

test("selectLatestCompletedLabelTestRun does not match on head branch alone when the head repository is unknown", () => {
  const selected = selectLatestCompletedLabelTestRun([
    forkRun({ id: 506, head_sha: "4444444444444444444444444444444444444444" }),
  ], { ...FORK_HEAD, headRepository: null });

  assert.equal(selected, null);
});

test("selectLatestPendingLabelTestRun finds an in-flight fork run", () => {
  const selected = selectLatestPendingLabelTestRun([
    forkRun({ id: 507, status: "in_progress" }),
  ], FORK_HEAD);

  assert.equal(selected.id, 507);
});

test("rerunLabelTestForPullRequest reruns the matching authoritative workflow run", async () => {
  const calls = [];
  const request = async (token, method, apiPath) => {
    calls.push({ token, method, apiPath });

    if (method === "GET") {
      return {
        workflow_runs: [
          {
            id: 901,
            event: "pull_request_target",
            status: "completed",
            created_at: "2026-08-02T10:00:00Z",
            pull_requests: [{ number: 42 }],
          },
        ],
      };
    }

    return null;
  };

  const run = await rerunLabelTestForPullRequest({
    token: "token-value",
    repository: "example/repository",
    pullRequestNumber: 42,
    request,
  });

  assert.equal(run.id, 901);
  assert.deepEqual(calls, [
    {
      token: "token-value",
      method: "GET",
      apiPath: "/repos/example/repository/actions/workflows/label-test.yml/runs?event=pull_request_target&per_page=100&page=1",
    },
    {
      token: "token-value",
      method: "POST",
      apiPath: "/repos/example/repository/actions/runs/901/rerun",
    },
  ]);
});

test("rerunLabelTestForPullRequest reruns the authoritative run for a fork pull request", async () => {
  const calls = [];
  const request = async (token, method, apiPath) => {
    calls.push({ method, apiPath });
    return method === "GET" ? { workflow_runs: [forkRun({ id: 902 })] } : null;
  };

  const run = await rerunLabelTestForPullRequest({
    token: "token-value",
    repository: "example/repository",
    request,
    ...FORK_HEAD,
  });

  assert.equal(run.id, 902);
  assert.equal(calls.at(-1).apiPath, "/repos/example/repository/actions/runs/902/rerun");
});

test("rerunLabelTestForPullRequest keeps paging until the fork run is found", async () => {
  const pages = {
    1: Array.from({ length: 100 }, (_unused, index) => forkRun({
      id: 1000 + index,
      head_sha: `${index}`.padStart(40, "0"),
      head_branch: `other-branch-${index}`,
    })),
    2: [forkRun({ id: 903 })],
  };
  const requested = [];
  const request = async (_token, method, apiPath) => {
    if (method !== "GET") {
      return null;
    }

    const page = Number(new URL(apiPath, "https://api.github.com").searchParams.get("page"));
    requested.push(page);
    return { workflow_runs: pages[page] ?? [] };
  };

  const run = await rerunLabelTestForPullRequest({
    token: "token-value",
    repository: "example/repository",
    request,
    ...FORK_HEAD,
  });

  assert.equal(run.id, 903);
  assert.deepEqual(requested, [1, 2]);
});

test("rerunLabelTestForPullRequest stops paging at maxPages", async () => {
  const requested = [];
  const request = async (_token, method, apiPath) => {
    if (method !== "GET") {
      return null;
    }

    requested.push(Number(new URL(apiPath, "https://api.github.com").searchParams.get("page")));
    return {
      workflow_runs: Array.from({ length: 100 }, (_unused, index) => forkRun({
        id: 2000 + requested.length * 100 + index,
        head_branch: "unrelated",
        head_sha: `${requested.length}${index}`.padStart(40, "0"),
      })),
    };
  };

  await assert.rejects(
    () => rerunLabelTestForPullRequest({
      token: "token-value",
      repository: "example/repository",
      maxPages: 3,
      request,
      ...FORK_HEAD,
    }),
    (error) => error.code === LABEL_TEST_RUN_NOT_FOUND,
  );

  assert.deepEqual(requested, [1, 2, 3]);
});

test("rerunLabelTestForPullRequest rejects when the PR has no completed authoritative run", async () => {
  const request = async () => ({ workflow_runs: [] });

  await assert.rejects(
    () => rerunLabelTestForPullRequest({
      token: "token-value",
      repository: "example/repository",
      pullRequestNumber: 42,
      request,
    }),
    /No completed Label Test pull_request_target run was found for example\/repository pull request #42\./,
  );
});

test("rerunLabelTestForPullRequest tags a missing run so the refresh can skip instead of fail", async () => {
  const request = async () => ({ workflow_runs: [] });

  await assert.rejects(
    () => rerunLabelTestForPullRequest({
      token: "token-value",
      repository: "example/repository",
      request,
      ...FORK_HEAD,
    }),
    (error) => {
      assert.equal(error.code, LABEL_TEST_RUN_NOT_FOUND);
      assert.match(error.message, /head contributor\/gt5-unofficial:spike-assembler-recipies @ c0fc457/);
      return true;
    },
  );
});

test("rerunLabelTestForPullRequest reports an in-flight run separately from a missing one", async () => {
  const request = async (_token, method) => (
    method === "GET" ? { workflow_runs: [forkRun({ id: 904, status: "in_progress" })] } : null
  );

  await assert.rejects(
    () => rerunLabelTestForPullRequest({
      token: "token-value",
      repository: "example/repository",
      request,
      ...FORK_HEAD,
    }),
    (error) => {
      assert.equal(error.code, LABEL_TEST_RUN_PENDING);
      assert.match(error.message, /run 904 .* has not completed yet/);
      return true;
    },
  );
});

test("rerunLabelTestForReviewSignal validates the artifact PR against the triggering head before rerunning", async () => {
  const calls = [];
  const request = async (_token, method, apiPath) => {
    calls.push({ method, apiPath });

    if (apiPath === "/repos/example/repository/pulls/42") {
      return {
        number: 42,
        state: "open",
        head: {
          sha: FORK_HEAD.headSha,
          ref: FORK_HEAD.headRef,
          repo: { full_name: FORK_HEAD.headRepository },
        },
        base: { repo: { full_name: "example/repository" } },
      };
    }

    if (method === "GET") {
      return { workflow_runs: [forkRun({ id: 905 })] };
    }

    return null;
  };

  const run = await rerunLabelTestForReviewSignal({
    token: "token-value",
    repository: "example/repository",
    pullRequestNumber: 42,
    expectedHeadSha: FORK_HEAD.headSha,
    request,
  });

  assert.equal(run.id, 905);
  assert.deepEqual(calls.map(({ method, apiPath }) => `${method} ${apiPath}`), [
    "GET /repos/example/repository/pulls/42",
    "GET /repos/example/repository/actions/workflows/label-test.yml/runs?event=pull_request_target&per_page=100&page=1",
    "POST /repos/example/repository/actions/runs/905/rerun",
  ]);
});

test("rerunLabelTestForReviewSignal rejects a tampered PR artifact before querying workflow runs", async () => {
  const calls = [];
  const request = async (_token, method, apiPath) => {
    calls.push({ method, apiPath });
    return {
      number: 7,
      state: "open",
      head: {
        sha: "1111111111111111111111111111111111111111",
        ref: "unrelated",
        repo: { full_name: "attacker/fork" },
      },
      base: { repo: { full_name: "example/repository" } },
    };
  };

  await assert.rejects(
    () => rerunLabelTestForReviewSignal({
      token: "token-value",
      repository: "example/repository",
      pullRequestNumber: 7,
      expectedHeadSha: FORK_HEAD.headSha,
      request,
    }),
    (error) => {
      assert.equal(error.code, REVIEW_SIGNAL_MISMATCH);
      assert.match(error.message, /does not match triggering workflow head/);
      return true;
    },
  );

  assert.deepEqual(calls, [
    { method: "GET", apiPath: "/repos/example/repository/pulls/7" },
  ]);
});
