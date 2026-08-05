import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RUNS_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 5;

export const LABEL_TEST_RUN_NOT_FOUND = "LABEL_TEST_RUN_NOT_FOUND";
export const LABEL_TEST_RUN_PENDING = "LABEL_TEST_RUN_PENDING";

function parsePullRequestNumber(value) {
  const pullRequestNumber = Number(value);

  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error("Pull request number must be a positive integer.");
  }

  return pullRequestNumber;
}

function optionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeRepository(value) {
  const repository = optionalString(value);
  return repository === null ? null : repository.toLowerCase();
}

export function parseRunMatchCriteria(value) {
  const source = value !== null && typeof value === "object" ? value : { pullRequestNumber: value };

  return {
    pullRequestNumber: parsePullRequestNumber(source.pullRequestNumber),
    headSha: optionalString(source.headSha),
    headRef: optionalString(source.headRef),
    headRepository: normalizeRepository(source.headRepository),
  };
}

function runTime(run) {
  const createdAt = Date.parse(run.created_at ?? "");
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function newestFirst(left, right) {
  return runTime(right) - runTime(left) || right.id - left.id;
}

function runHeadRepository(run) {
  return normalizeRepository(run?.head_repository?.full_name);
}

function isLabelTestRun(run) {
  return run?.event === "pull_request_target";
}

function matchesExactly(run, criteria) {
  const linkedByNumber = Array.isArray(run.pull_requests)
    && run.pull_requests.some((pullRequest) => pullRequest?.number === criteria.pullRequestNumber);

  if (linkedByNumber) {
    return true;
  }

  if (criteria.headSha === null || run.head_sha !== criteria.headSha) {
    return false;
  }

  const headRepository = runHeadRepository(run);
  return criteria.headRepository === null
    || headRepository === null
    || headRepository === criteria.headRepository;
}

function matchesByHeadBranch(run, criteria) {
  if (criteria.headRef === null || criteria.headRepository === null) {
    return false;
  }

  return run.head_branch === criteria.headRef
    && runHeadRepository(run) === criteria.headRepository;
}

function selectRun(runs, criteriaValue, statusPredicate) {
  const criteria = parseRunMatchCriteria(criteriaValue);
  const candidates = runs
    .filter((run) => isLabelTestRun(run) && statusPredicate(run.status))
    .sort(newestFirst);

  return candidates.find((run) => matchesExactly(run, criteria))
    ?? candidates.find((run) => matchesByHeadBranch(run, criteria))
    ?? null;
}

export function selectLatestCompletedLabelTestRun(runs, criteriaValue) {
  return selectRun(runs, criteriaValue, (status) => status === "completed");
}

export function selectLatestPendingLabelTestRun(runs, criteriaValue) {
  return selectRun(runs, criteriaValue, (status) => status !== "completed");
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

function describeHead(criteria) {
  const parts = [];

  if (criteria.headRepository !== null && criteria.headRef !== null) {
    parts.push(`${criteria.headRepository}:${criteria.headRef}`);
  } else if (criteria.headRef !== null) {
    parts.push(criteria.headRef);
  }

  if (criteria.headSha !== null) {
    parts.push(criteria.headSha.slice(0, 7));
  }

  return parts.length === 0 ? "" : ` (head ${parts.join(" @ ")})`;
}

export async function rerunLabelTestForPullRequest({
  token,
  repository,
  pullRequestNumber: pullRequestNumberValue,
  headSha,
  headRef,
  headRepository,
  workflowPath = "label-test.yml",
  maxPages = DEFAULT_MAX_PAGES,
  request = githubRequest,
}) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required.");
  }

  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("TARGET_REPOSITORY must match owner/repo.");
  }

  const criteria = parseRunMatchCriteria({
    pullRequestNumber: pullRequestNumberValue,
    headSha,
    headRef,
    headRepository,
  });
  const encodedWorkflowPath = encodeURIComponent(workflowPath);
  const collectedRuns = [];
  let page = 1;
  let selectedRun = null;

  while (page <= maxPages) {
    const response = await request(
      token,
      "GET",
      `/repos/${repository}/actions/workflows/${encodedWorkflowPath}/runs?event=pull_request_target&per_page=${RUNS_PER_PAGE}&page=${page}`,
    );
    const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
    collectedRuns.push(...runs);

    selectedRun = selectLatestCompletedLabelTestRun(collectedRuns, criteria);

    if (selectedRun || runs.length < RUNS_PER_PAGE) {
      break;
    }

    page += 1;
  }

  if (!selectedRun) {
    const pendingRun = selectLatestPendingLabelTestRun(collectedRuns, criteria);
    const error = new Error(
      pendingRun
        ? `Label Test pull_request_target run ${pendingRun.id} for ${repository} pull request #${criteria.pullRequestNumber}${describeHead(criteria)} has not completed yet.`
        : `No completed Label Test pull_request_target run was found for ${repository} pull request #${criteria.pullRequestNumber}${describeHead(criteria)}.`,
    );
    error.code = pendingRun ? LABEL_TEST_RUN_PENDING : LABEL_TEST_RUN_NOT_FOUND;
    throw error;
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
    headSha: process.env.PULL_REQUEST_HEAD_SHA,
    headRef: process.env.PULL_REQUEST_HEAD_REF,
    headRepository: process.env.PULL_REQUEST_HEAD_REPOSITORY,
    workflowPath: process.env.LABEL_TEST_WORKFLOW_PATH,
  });

  console.log(`Requested rerun of Label Test workflow run ${run.id}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error.code === LABEL_TEST_RUN_NOT_FOUND || error.code === LABEL_TEST_RUN_PENDING) {
      console.log(`${error.message} Nothing to refresh; skipping.`);
      return;
    }

    console.error(error.message);
    process.exitCode = 1;
  });
}
