import { normalizeName } from "./config-utils.mjs";
import { getAllPages } from "./wait-for-merge-runner.mjs";
import {
  addReaction,
  branchMatchesPattern,
  createMemberChecker,
  isBotUser,
  isValidRefName,
  mention,
  notice,
  parseCommandLines,
  postComment,
  warn,
} from "./command-utils.mjs";

// /cherry-pick <branch> and /release <tag> act when the pull request merges. Nothing is stored: when Label
// Sync hears that a pull request closed (a "pull-request-closed" repository_dispatch, or a command posted
// after the merge), it reads the comments and description again and works out what was asked. Editing or
// deleting a command before the merge changes or cancels it.
//
// When a command is posted, it only gets a reaction: 👍 if it is valid now, 👎 if not. A 👎 for someone who
// may run the command comes with a reply saying what is wrong. The real checks are made again at merge time.

export const CHERRY_PICK_COMMAND = "cherry-pick";
export const RELEASE_COMMAND = "release";
export const CHERRY_PICK_HEADING = "**Cherry-pick**";
export const RELEASE_HEADING = "**Release**";

export function isCherryPickEnabled(config) {
  return Boolean(config?.cherryPick);
}

export function isReleaseEnabled(config) {
  return Boolean(config?.release);
}

export function cherryPickBranchName(number, branch) {
  return `cherry-pick/${number}-to-${branch}`;
}

function encodeRef(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

export function parseCherryPickArgs(args, config) {
  const branch = args?.[0];

  if (!branch) {
    return { error: "no branch was given" };
  }

  if (!isValidRefName(branch)) {
    return { error: `"${branch}" is not a valid branch name` };
  }

  if (!config.cherryPick.branches.some((pattern) => branchMatchesPattern(branch, pattern))) {
    return { error: `\`${branch}\` is not a branch you can cherry-pick into (allowed: ${config.cherryPick.branches.map((pattern) => `\`${pattern}\``).join(", ")})` };
  }

  return { branch };
}

export function parseReleaseArgs(args) {
  const tag = args?.[0];

  if (!tag) {
    return { error: "no tag was given" };
  }

  if (!isValidRefName(tag)) {
    return { error: `"${tag}" is not a valid tag name` };
  }

  return { tag };
}

async function refExists(request, repository, ref) {
  try {
    const found = await request("GET", `/repos/${repository}/git/ref/${encodeRef(ref)}`);
    return found ?? true;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function branchExists(request, repository, branch) {
  try {
    await request("GET", `/repos/${repository}/branches/${encodeRef(branch)}`);
    return true;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}

// Reacts to a newly posted /cherry-pick or /release comment. Returns { merged: true } when the pull request had
// already merged, so the caller runs the merge-time work straight away.
export async function acknowledgeMergeCommand({
  request,
  config,
  command,
  repository,
  number,
  issue,
  comment,
  commands,
  isTeamMember,
  log = console.log,
}) {
  if (!issue?.pull_request) {
    return { ignored: "not-pull-request" };
  }

  const settings = command === CHERRY_PICK_COMMAND ? config.cherryPick : config.release;
  const commenter = comment.user.login;

  if (!(await createMemberChecker(settings.allowedUsers, isTeamMember)(commenter))) {
    notice(log, "Command ignored", `${commenter} is not allowed to run /${command}.`);
    await addReaction({ request, repository, commentId: comment.id, content: "-1", log });
    return { ignored: "not-allowed" };
  }

  const pullRequest = await request("GET", `/repos/${repository}/pulls/${number}`);
  const problems = [];

  if (pullRequest?.state === "closed" && !pullRequest?.merged_at) {
    problems.push("this pull request was closed without merging");
  }

  for (const { args } of commands) {
    if (command === CHERRY_PICK_COMMAND) {
      const parsed = parseCherryPickArgs(args, config);

      if (parsed.error) {
        problems.push(parsed.error);
      } else if (normalizeName(parsed.branch) === normalizeName(pullRequest?.base?.ref ?? "")) {
        problems.push(`this pull request already targets \`${parsed.branch}\``);
      } else if (!(await branchExists(request, repository, parsed.branch))) {
        problems.push(`\`${parsed.branch}\` does not exist in ${repository}`);
      }
    } else {
      const parsed = parseReleaseArgs(args);
      const defaultBranch = pullRequest?.base?.repo?.default_branch;

      if (parsed.error) {
        problems.push(parsed.error);
      } else if (defaultBranch && pullRequest?.base?.ref !== defaultBranch) {
        problems.push(`releases are only made from pull requests into \`${defaultBranch}\``);
      } else if (await refExists(request, repository, `tags/${parsed.tag}`)) {
        problems.push(`the tag \`${parsed.tag}\` already exists`);
      }
    }
  }

  await addReaction({ request, repository, commentId: comment.id, content: problems.length > 0 ? "-1" : "+1", log });

  if (problems.length > 0) {
    await postComment({
      request,
      repository,
      number,
      body: [
        `${command === CHERRY_PICK_COMMAND ? CHERRY_PICK_HEADING : RELEASE_HEADING}`,
        "",
        `${mention([commenter])} your \`/${command}\` command will not do anything yet:`,
        "",
        ...problems.map((problem) => `- ${problem}.`),
        "",
        "Edit the comment or post a new one once it is fixed.",
      ].join("\n"),
    });
    return { problems };
  }

  return { accepted: true, merged: Boolean(pullRequest?.merged_at) };
}

const DESCRIPTION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      body
      createdAt
      lastEditedAt
      author { __typename login }
      editor { __typename login }
    }
  }
}`;

// The description counts as written by whoever edited it last (or its author, if nobody has), so a /release
// line only works if that person may run the command.
async function readDescription(request, repository, number) {
  const [owner, name] = repository.split("/");
  const response = await request("POST", "/graphql", { query: DESCRIPTION_QUERY, variables: { owner, name, number: Number(number) } });

  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error(`Reading the description failed: ${response.errors.map((error) => error.message).join("; ")}`);
  }

  const pullRequest = response?.data?.repository?.pullRequest;
  const actor = pullRequest?.editor ?? pullRequest?.author;

  return {
    body: typeof pullRequest?.body === "string" ? pullRequest.body : "",
    login: actor?.login ?? null,
    isBot: actor?.__typename === "Bot",
    time: pullRequest?.lastEditedAt ?? pullRequest?.createdAt ?? null,
  };
}

function timeOf(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

// Collects the valid requests from people allowed to make them, oldest first.
export async function collectMergeRequests({
  request,
  config,
  repository,
  number,
  comments,
  isTeamMember,
  isAutomationActor,
  log = console.log,
}) {
  const cherryPicks = new Map();
  const releases = [];
  const isCherryPickRunner = isCherryPickEnabled(config) ? createMemberChecker(config.cherryPick.allowedUsers, isTeamMember) : null;
  const isReleaseRunner = isReleaseEnabled(config) ? createMemberChecker(config.release.allowedUsers, isTeamMember) : null;

  const sources = [...(comments ?? [])]
    .filter((comment) => typeof comment?.body === "string" && typeof comment?.user?.login === "string")
    .map((comment) => ({ login: comment.user.login, bot: isBotUser(comment.user), time: comment.created_at, body: comment.body, leading: true }));

  if (isReleaseRunner) {
    const description = await readDescription(request, repository, number);
    sources.push({ login: description.login, bot: description.isBot, time: description.time, body: description.body, leading: false, description: true });
  }

  sources.sort((a, b) => timeOf(a.time) - timeOf(b.time));

  for (const source of sources) {
    if (!source.login || source.bot || await isAutomationActor(source.login)) {
      continue;
    }

    for (const { name, args } of parseCommandLines(source.body, { requireLeadingCommand: source.leading })) {
      if (name === CHERRY_PICK_COMMAND && isCherryPickRunner && !source.description) {
        const parsed = parseCherryPickArgs(args, config);

        if (!parsed.error && await isCherryPickRunner(source.login)) {
          const key = parsed.branch;
          const entry = cherryPicks.get(key) ?? { branch: parsed.branch, runners: [] };
          if (!entry.runners.some((runner) => normalizeName(runner) === normalizeName(source.login))) {
            entry.runners.push(source.login);
          }
          cherryPicks.set(key, entry);
        }
      }

      if (name === RELEASE_COMMAND && isReleaseRunner) {
        const parsed = parseReleaseArgs(args);

        if (!parsed.error && await isReleaseRunner(source.login)) {
          releases.push({ tag: parsed.tag, login: source.login, time: source.time, fromDescription: Boolean(source.description) });
        } else if (!parsed.error && source.description) {
          notice(log, "Release ignored", `The description of ${repository}#${number} asks for a release, but ${source.login} last edited it and is not allowed to run /release.`);
        }
      }
    }
  }

  return { cherryPicks: [...cherryPicks.values()], release: releases.at(-1) ?? null };
}

// Squash and merge-commit merges land one commit; a rebase merge lands every commit of the pull request. A
// rebased commit keeps its message, so the last pull request commit's message on the merge commit means a
// rebase merge.
export async function planCommitsToPick(request, repository, pullRequest) {
  const mergeCommitSha = pullRequest.merge_commit_sha;
  const commit = await request("GET", `/repos/${repository}/commits/${mergeCommitSha}`);

  if ((commit?.parents?.length ?? 1) > 1) {
    return { mergeCommitSha, count: 1, mainline: 1, method: "merge" };
  }

  const commitCount = Number(pullRequest.commits ?? 1);

  if (commitCount > 1) {
    const commits = await getAllPages(request, `/repos/${repository}/pulls/${pullRequest.number}/commits`);
    const lastMessage = commits.at(-1)?.commit?.message;

    if (lastMessage && lastMessage === commit?.commit?.message) {
      return { mergeCommitSha, count: commitCount, mainline: null, method: "rebase" };
    }
  }

  return { mergeCommitSha, count: 1, mainline: null, method: "squash" };
}

async function cherryPickInto({ request, config, repository, pullRequest, target, cherryPick, log }) {
  const { branch, runners } = target;
  const number = pullRequest.number;
  const headBranch = cherryPickBranchName(number, branch);
  const [owner] = repository.split("/");
  const existing = await request("GET", `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headBranch}`)}`);

  if (Array.isArray(existing) && existing.length > 0) {
    log(`${repository}#${number} was already cherry-picked into ${branch} (#${existing[0].number}).`);
    return { branch, skipped: "exists", pullRequest: existing[0] };
  }

  if (!(await branchExists(request, repository, branch))) {
    return { branch, runners, failed: `\`${branch}\` does not exist` };
  }

  // A branch left by an earlier run that pushed but could not open the pull request is reused.
  if (!(await branchExists(request, repository, headBranch))) {
    const plan = await planCommitsToPick(request, repository, pullRequest);
    const result = await cherryPick({
      repository,
      mergeCommitSha: plan.mergeCommitSha,
      count: plan.count,
      mainline: plan.mainline,
      targetBranch: branch,
      headBranch,
    });

    if (!result.ok) {
      const conflicts = result.conflicts?.length
        ? ` Conflicting files: ${result.conflicts.slice(0, 20).map((file) => `\`${file}\``).join(", ")}.`
        : "";
      return { branch, runners, failed: `${result.reason}.${conflicts}` };
    }
  }

  const created = await request("POST", `/repos/${repository}/pulls`, {
    title: `[${branch}] ${pullRequest.title}`,
    head: headBranch,
    base: branch,
    body: [
      `Cherry-pick of #${number} into \`${branch}\`, requested by ${mention(runners)}.`,
      "",
      `Opened by Label Sync after #${number} merged as ${pullRequest.merge_commit_sha}.`,
    ].join("\n"),
  });

  const labels = (pullRequest.labels ?? [])
    .map((label) => label?.name)
    .filter((name) => name && normalizeName(name) !== normalizeName(config.cherryPick.label));

  if (labels.length > 0) {
    try {
      await request("POST", `/repos/${repository}/issues/${created.number}/labels`, { labels });
    } catch (error) {
      warn(log, "Cherry-pick labels failed", error.message);
    }
  }

  try {
    await request("POST", `/repos/${repository}/issues/${created.number}/assignees`, { assignees: runners });
  } catch (error) {
    warn(log, "Cherry-pick assignees failed", error.message);
  }

  notice(log, "Cherry-pick opened", `${repository}#${created.number} applies #${number} to ${branch}.`);
  return { branch, runners, pullRequest: created };
}

async function createReleaseFor({ request, repository, pullRequest, release, log }) {
  const { tag, login } = release;
  const defaultBranch = pullRequest?.base?.repo?.default_branch;

  if (defaultBranch && pullRequest.base.ref !== defaultBranch) {
    return { tag, login, failed: `releases are only made from pull requests into \`${defaultBranch}\`, and this one merged into \`${pullRequest.base.ref}\`` };
  }

  const existingTag = await refExists(request, repository, `tags/${tag}`);

  if (existingTag) {
    // A rerun after Label Sync already released this merge is not an error.
    try {
      const existingRelease = await request("GET", `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
      if (existingTag?.object?.sha === pullRequest.merge_commit_sha && existingRelease) {
        log(`${tag} was already released from ${pullRequest.merge_commit_sha}.`);
        return { tag, login, skipped: "exists", release: existingRelease };
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    return { tag, login, failed: `the tag \`${tag}\` already exists, so no release was created` };
  }

  const created = await request("POST", `/repos/${repository}/releases`, {
    tag_name: tag,
    target_commitish: pullRequest.merge_commit_sha,
    name: tag,
    generate_release_notes: true,
    draft: false,
    prerelease: false,
    make_latest: "true",
  });

  notice(log, "Release created", `${repository} ${tag} from #${pullRequest.number}.`);
  return { tag, login, release: created };
}

// Runs every /cherry-pick and /release for one merged pull request. Throws after reporting if anything that
// was asked for could not be done, so the run fails.
export async function runMergeCommands({
  request,
  config,
  repository,
  number,
  isTeamMember,
  isAutomationActor,
  cherryPick,
  log = console.log,
}) {
  const outcome = { merged: false, cherryPicks: [], release: null, labelMissing: false };

  if (!isCherryPickEnabled(config) && !isReleaseEnabled(config)) {
    return outcome;
  }

  const pullRequest = await request("GET", `/repos/${repository}/pulls/${number}`);

  if (!pullRequest?.merged_at || !pullRequest?.merge_commit_sha) {
    log(`${repository}#${number} is not merged; nothing to do.`);
    return outcome;
  }

  outcome.merged = true;
  const comments = await getAllPages(request, `/repos/${repository}/issues/${number}/comments`);
  const requests = await collectMergeRequests({ request, config, repository, number, comments, isTeamMember, isAutomationActor, log });
  const failures = [];

  if (requests.cherryPicks.length > 0) {
    const labelKey = normalizeName(config.cherryPick.label);
    const hasLabel = (pullRequest.labels ?? []).some((label) => normalizeName(label?.name ?? "") === labelKey);

    if (!hasLabel) {
      outcome.labelMissing = true;
      const branches = requests.cherryPicks.map((target) => `\`${target.branch}\``).join(", ");
      notice(log, "Cherry-pick skipped", `${repository}#${number} merged without the "${config.cherryPick.label}" label.`);
      await postComment({
        request,
        repository,
        number,
        body: [
          CHERRY_PICK_HEADING,
          "",
          `${mention(requests.cherryPicks.flatMap((target) => target.runners))} this pull request merged without the \`${config.cherryPick.label}\` label, so it was not cherry-picked into ${branches}.`,
        ].join("\n"),
      });
    } else {
      for (const target of requests.cherryPicks) {
        let result;

        try {
          result = await cherryPickInto({ request, config, repository, pullRequest, target, cherryPick, log });
        } catch (error) {
          result = { branch: target.branch, runners: target.runners, failed: "Label Sync hit an error", error };
        }

        outcome.cherryPicks.push(result);

        if (result.failed) {
          failures.push(`cherry-pick into ${target.branch}: ${result.error?.message ?? result.failed}`);
          await postComment({
            request,
            repository,
            number,
            body: [
              CHERRY_PICK_HEADING,
              "",
              `${mention(target.runners)} Label Sync could not cherry-pick this pull request into \`${target.branch}\`: ${result.failed}`,
              "",
              "Please cherry-pick it by hand.",
            ].join("\n"),
          });
        } else if (!result.skipped) {
          await postComment({
            request,
            repository,
            number,
            body: `${CHERRY_PICK_HEADING}\n\n${mention(target.runners)} opened #${result.pullRequest.number} to cherry-pick this into \`${target.branch}\`.`,
          });
        }
      }
    }
  }

  if (requests.release) {
    let result;

    try {
      result = await createReleaseFor({ request, repository, pullRequest, release: requests.release, log });
    } catch (error) {
      result = { tag: requests.release.tag, login: requests.release.login, failed: "Label Sync hit an error", error };
    }

    outcome.release = result;

    if (result.failed) {
      failures.push(`release ${result.tag}: ${result.error?.message ?? result.failed}`);
      await postComment({
        request,
        repository,
        number,
        body: `${RELEASE_HEADING}\n\n${mention([result.login])} ${result.failed}.${result.error ? " Please create the release by hand." : ""}`,
      });
    } else if (!result.skipped) {
      await postComment({
        request,
        repository,
        number,
        body: `${RELEASE_HEADING}\n\n${mention([result.login])} released [${result.tag}](${result.release?.html_url ?? `https://github.com/${repository}/releases/tag/${encodeURIComponent(result.tag)}`}).`,
      });
    }
  }

  if (failures.length > 0) {
    const error = new Error(`Merge commands failed for ${repository}#${number}: ${failures.join("; ")}`);
    error.outcome = outcome;
    throw error;
  }

  return outcome;
}
