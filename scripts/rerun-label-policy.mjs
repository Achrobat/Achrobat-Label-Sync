import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

function parsePullRequestNumber(value) {
  const pullRequestNumber = Number(value);

  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error("Pull request number must be a positive integer.");
  }

  return pullRequestNumber;
}

function runTime(run) {
  const createdAt = Date.parse(run.created_at ?? "");
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

export function selectLatestCompletedLabelTestRun(runs, pullRequestNumberValue) {
  const pullRequestNumber = parsePullRequestNumber(pullRequestNumberValue);

  return runs
    .filter((run) => (
      run?.event === "pull_request_target"
      && run.status === "completed"
      && Array.isArray(run.pull_requests)
      && run.pull_requests.some((pullRequest) => pullRequest?.number === pullRequestNumber)
    ))
    .sort((left, right) => runTime(right) - runTime(left) || right.id - left.id)[0] ?? null;
}

async function githubRequest(token, method, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync-review-refresh",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function rerunLabelTestForPullRequest({
  token,
  repository,
  pullRequestNumber: pullRequestNumberValue,
  workflowPath = "label-test.yml",
  request = githubRequest,
}) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required.");
  }

  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("TARGET_REPOSITORY must match owner/repo.");
  }

  const pullRequestNumber = parsePullRequestNumber(pullRequestNumberValue);
  const encodedWorkflowPath = encodeURIComponent(workflowPath);
  let page = 1;
  let selectedRun = null;

  while (!selectedRun) {
    const response = await request(
      token,
      "GET",
      `/repos/${repository}/actions/workflows/${encodedWorkflowPath}/runs?event=pull_request_target&per_page=100&page=${page}`,
    );
    const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
    selectedRun = selectLatestCompletedLabelTestRun(runs, pullRequestNumber);

    if (selectedRun || runs.length < 100) {
      break;
    }

    page += 1;
  }

  if (!selectedRun) {
    throw new Error(
      `No completed Label Test pull_request_target run was found for ${repository} pull request #${pullRequestNumber}.`,
    );
  }

  await request(
    token,
    "POST",
    `/repos/${repository}/actions/runs/${selectedRun.id}/rerun`,
  );

  return selectedRun;
}

async function readPullRequestNumber() {
  if (process.env.PULL_REQUEST_NUMBER) {
    return process.env.PULL_REQUEST_NUMBER;
  }

  if (process.env.PULL_REQUEST_NUMBER_FILE) {
    return fs.readFile(process.env.PULL_REQUEST_NUMBER_FILE, "utf8");
  }

  throw new Error("PULL_REQUEST_NUMBER or PULL_REQUEST_NUMBER_FILE is required.");
}

async function main() {
  const run = await rerunLabelTestForPullRequest({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.TARGET_REPOSITORY,
    pullRequestNumber: await readPullRequestNumber(),
    workflowPath: process.env.LABEL_TEST_WORKFLOW_PATH,
  });

  console.log(`Requested rerun of Label Test workflow run ${run.id}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
