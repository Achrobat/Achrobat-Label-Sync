import assert from "node:assert/strict";
import test from "node:test";

import {
  rerunLabelTestForPullRequest,
  selectLatestCompletedLabelTestRun,
} from "../scripts/rerun-label-policy.mjs";

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
