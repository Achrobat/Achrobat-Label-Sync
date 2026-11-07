import { normalizeName } from "./config-utils.mjs";
import { isBotUser, mention } from "./command-utils.mjs";

// The wait-for-merge command keeps a configured label on a pull request until every pull request linked with
// the command is merged or closed. Nothing is stored outside the pull request: every run works the state out
// again from the comments, the label history and the live state of the linked pull requests, so reruns,
// retries and replayed event payloads all reach the same answer.
//
// The command comment is also the status display. Label Sync puts an icon in front of every link and keeps one
// note line at the end, marked with a hidden HTML comment that also records the comment's state: "waiting"
// once the command is accepted, then "done", "cancelled" or "rejected". Label Sync only ever rewrites those
// icons and that note line, never the user's links or other text.
//
// A "wait" lasts from the latest removal of the label until the label is removed again, either by Label Sync
// (every linked pull request is merged or closed, or nothing is left to wait on) or by anyone else, which
// cancels it. Only commands posted inside the current wait count, so after a wait ends a fresh command is
// needed. Label Sync taking back a label someone added by hand does not count as the end of a wait.

export const READY_TO_MERGE_PHRASE = "This pull request is ready to merge";
const NOTE_PATTERN = /<!-- wait-for-merge:(waiting|rejected|done|cancelled) -->/;
const COMMAND_PATTERN = /^(\s*\/wait-for-merge)(?=\s|$)(.*)$/i;
const ICON_PATTERN = /(?:✅|⏳|❌|❓)️?[ \t]?/gu;
const TOKEN_PATTERN = /[^\s,]+/g;
const MAX_ECHOED_ARGUMENT_LENGTH = 100;

// How far the loop check follows other pull requests' waits (A waits on B, B on C, C on D), and how many pull
// requests it may read in total for one command.
export const LOOP_SEARCH_DEPTH = 3;
export const LOOP_SEARCH_LIMIT = 20;

export const ICONS = {
  open: "⏳",
  unreadable: "⏳",
  merged: "✅",
  closed: "❌",
  invalid: "❓",
};

// "unreadable" means Label Sync could not read the pull request for a reason other than it not existing (for
// example a permission or rate limit problem), so it keeps counting as open.
const PENDING_STATES = new Set(["open", "unreadable"]);
const FINISHED_STATES = new Set(["merged", "closed"]);

export function isWaitForMergeEnabled(config) {
  return Boolean(config?.waitForMerge?.label);
}

// Accepts a pull request URL, "owner/repo#123", or "#123" for a pull request in the same repository.
export function parsePullRequestReference(argument, repository) {
  const value = String(argument ?? "").trim().replace(/^<(.*)>$/, "$1");

  if (!value) {
    return { error: "no pull request link was given" };
  }

  let match = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(value)
    ?? /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(value);

  if (!match) {
    const shortMatch = /^#(\d+)$/.exec(value);
    const [owner, repo] = String(repository ?? "").split("/");

    if (shortMatch && owner && repo) {
      match = [value, owner, repo, shortMatch[1]];
    }
  }

  if (!match) {
    return { error: "not a pull request link" };
  }

  const number = Number(match[3]);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return { error: "not a pull request link" };
  }

  return {
    owner: match[1],
    repo: match[2],
    number,
  };
}

export function formatPullRequestReference(reference) {
  return `${reference.owner}/${reference.repo}#${reference.number}`;
}

function referenceKey(reference) {
  return normalizeName(formatPullRequestReference(reference));
}

function repositoryOwner(repository) {
  return normalizeName(String(repository ?? "").split("/")[0] ?? "");
}

function timeOf(value) {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? 0 : time;
}

function numericId(value) {
  return Number.isFinite(value) ? value : 0;
}

function byCreation(left, right) {
  return timeOf(left?.created_at) - timeOf(right?.created_at) || numericId(left?.id) - numericId(right?.id);
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueLogins(logins) {
  const result = [];

  for (const login of logins) {
    if (!result.some((item) => normalizeName(item) === normalizeName(login))) {
      result.push(login);
    }
  }

  return result;
}

// User text is echoed inside a code span so it can never mention anyone or render as markdown.
function echoArgument(text) {
  const cleaned = String(text ?? "").replace(/[`\r\n]/g, "");
  const shortened = cleaned.length > MAX_ECHOED_ARGUMENT_LENGTH
    ? `${cleaned.slice(0, MAX_ECHOED_ARGUMENT_LENGTH)}…`
    : cleaned;
  return shortened ? `\`${shortened}\`` : "(empty)";
}

// Commands must start the comment. Every line of that comment that starts with the command is read, so one
// comment can hold several command lines. Returns the text after the command on each line.
export function findCommandLines(body) {
  if (typeof body !== "string" || !body.trimStart().startsWith("/")) {
    return [];
  }

  const lines = [];

  for (const line of body.split(/\r?\n/)) {
    if (NOTE_PATTERN.test(line)) {
      continue;
    }

    const match = COMMAND_PATTERN.exec(line);

    if (match) {
      lines.push(match[2]);
    }
  }

  return lines;
}

// Surrounding punctuation is not part of a link: "(#12)", "`#12`", "#12." and "#12;" all mean #12.
function cleanToken(token) {
  return token.replace(/^[("'[`]+/, "").replace(/[.;:!?)"'\]`]+$/, "");
}

// Plain words after the links are ignored, so a command can explain itself. Anything that looks like an
// attempt at a link is read as one, so a typo is reported instead of silently dropped.
function looksLikeLink(value) {
  return value.startsWith("#")
    || /^<?https?:\/\/(?:www\.)?github\.com\//i.test(value)
    || /\/pull\/\d/i.test(value)
    || /^[^\s/#]+\/[^\s/#]+#/.test(value);
}

// Reads the links on one command line, ignoring the status icons Label Sync put there. Links may be separated
// by spaces, commas or both. Returns { text, reference } for each link, or { text, error } when a link-like
// word is not a valid pull request reference.
export function parseWaitForMergeLinks(args, repository) {
  const links = [];

  for (const match of String(args ?? "").replace(ICON_PATTERN, "").matchAll(TOKEN_PATTERN)) {
    const value = cleanToken(match[0]);

    if (!value || !looksLikeLink(value)) {
      continue;
    }

    const reference = parsePullRequestReference(value, repository);
    links.push(reference.error ? { text: value, error: reference.error } : { text: value, reference });
  }

  return links;
}

export function readNoteKind(body) {
  return NOTE_PATTERN.exec(String(body ?? ""))?.[1] ?? null;
}

function renderNote(kind, text) {
  return `_${text}_ <!-- wait-for-merge:${kind} -->`;
}

// Puts icons[i] in front of the i-th link of the line, replacing whatever icons were there before.
function annotateArguments(args, icons) {
  let index = 0;

  return args.replace(ICON_PATTERN, "").replace(TOKEN_PATTERN, (token) => {
    const value = cleanToken(token);

    if (!value || !looksLikeLink(value)) {
      return token;
    }

    const icon = icons[index];
    index += 1;
    return icon ? `${icon} ${token}` : token;
  });
}

// Rewrites a command comment with fresh icons (one array per command line) and a single note line at the end.
// Everything else the user wrote is kept as it is, including its line endings.
export function renderCommentBody(body, iconsByLine, note) {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const output = [];
  let commandIndex = 0;

  for (const line of body.split(/\r?\n/)) {
    if (NOTE_PATTERN.test(line)) {
      continue;
    }

    const match = COMMAND_PATTERN.exec(line);

    if (match) {
      output.push(`${match[1]}${annotateArguments(match[2], iconsByLine[commandIndex] ?? [])}`);
      commandIndex += 1;
    } else {
      output.push(line);
    }
  }

  while (output.length > 0 && output.at(-1).trim() === "") {
    output.pop();
  }

  return [...output, "", note].join(eol);
}

// Walks the label's history. The latest removal starts the current wait, except when Label Sync took back a
// label that someone else had added: that never was a wait. Also returns who added the label last, so a label
// added by hand can be recognized and removed.
async function readLabelHistory(labelEvents, labelKey, isAutomationActor) {
  const events = [...(labelEvents ?? [])]
    .filter((event) => (
      (event?.event === "labeled" || event?.event === "unlabeled")
      && typeof event.label?.name === "string"
      && normalizeName(event.label.name) === labelKey
    ))
    .sort(byCreation);
  let addedByApp = null;
  let latestAdd = null;
  let windowStart = 0;
  const removals = [];

  for (const event of events) {
    const actor = typeof event.actor?.login === "string" ? event.actor.login : null;
    const byApp = Boolean(actor) && await isAutomationActor(actor);

    if (event.event === "labeled") {
      addedByApp = byApp;
      latestAdd = { actor, byApp };
      continue;
    }

    if (byApp && addedByApp === false) {
      addedByApp = null;
      continue;
    }

    const time = timeOf(event.created_at);
    removals.push({ time, actor, byApp });
    windowStart = Math.max(windowStart, time);
    addedByApp = null;
  }

  return { windowStart, removals, latestAdd };
}

// The pull requests another pull request is waiting on right now: the links of its accepted commands inside
// its current wait, while it has the label. Used to refuse waits that would loop.
export async function readActiveWaitLinks({
  config,
  repository,
  labels,
  comments,
  labelEvents,
  isAllowedRunner,
  isAutomationActor,
}) {
  const label = config?.waitForMerge?.label;

  if (!label) {
    return [];
  }

  const labelKey = normalizeName(label);

  if (!(labels ?? []).some((item) => normalizeName(item?.name ?? "") === labelKey)) {
    return [];
  }

  const { windowStart } = await readLabelHistory(labelEvents, labelKey, isAutomationActor);
  const references = [];

  for (const comment of comments ?? []) {
    if (
      typeof comment?.body !== "string"
      || isBotUser(comment.user)
      || timeOf(comment.created_at) < windowStart
      || readNoteKind(comment.body) !== "waiting"
    ) {
      continue;
    }

    const lines = findCommandLines(comment.body);

    if (lines.length === 0 || !(await isAllowedRunner(comment.user?.login))) {
      continue;
    }

    for (const args of lines) {
      for (const link of parseWaitForMergeLinks(args, repository)) {
        if (link.reference) {
          references.push(link.reference);
        }
      }
    }
  }

  return references;
}

function renderReadyToMergeBody(runners) {
  const mentions = mention(runners.filter((login) => !/\[bot\]$/i.test(login)));
  return `${mentions ? `${mentions} ` : ""}${READY_TO_MERGE_PHRASE}: every pull request it was waiting on is now merged or closed.`;
}

// Plans one reconcile of a pull request.
//
// mode "command" runs for a comment that was just created or edited (triggeringCommentId), or deleted (no
// triggering comment). Only that mode looks at a comment that is not yet accepted, gives reactions, checks
// for loops and adds the label, and it adds the label only when the triggering comment is accepted. mode
// "check" (Label Test runs and the central Wait-For-Merge workflow) refreshes accepted commands, completes or
// ends the wait, takes back a label added by hand and finishes off commands from an earlier wait.
//
// Callbacks: isAllowedRunner(login), isAutomationActor(login), getPullRequestState(reference) resolving to
// "open", "merged", "closed", "missing" or "unreadable", isApproved() (only called when a wait completes), and
// findActiveWaitLinks(reference) (only called for the loop check).
export async function planWaitForMerge({
  config,
  repository,
  pullRequestNumber,
  prLabels,
  comments,
  labelEvents,
  mode = "check",
  triggeringCommentId = null,
  isAllowedRunner,
  isAutomationActor,
  getPullRequestState,
  isApproved = async () => false,
  findActiveWaitLinks = async () => [],
}) {
  const settings = config?.waitForMerge;
  const plan = {
    enabled: Boolean(settings?.label),
    triggerRejected: null,
    status: null,
    commentEdits: [],
    reactions: [],
    addLabel: false,
    removeLabel: null,
    readyToMergeComment: null,
    dependencies: [],
    runners: [],
  };

  if (!plan.enabled) {
    return plan;
  }

  const labelKey = normalizeName(settings.label);
  const presentLabel = (prLabels ?? []).find((label) => normalizeName(label?.name ?? "") === labelKey);
  const labelName = presentLabel?.name ?? settings.label;
  const history = await readLabelHistory(labelEvents, labelKey, isAutomationActor);
  const manualLabel = Boolean(presentLabel) && history.latestAdd !== null && !history.latestAdd.byApp;
  const ownKey = normalizeName(`${repository}#${pullRequestNumber}`);
  const ownOwner = repositoryOwner(repository);
  const triggeringId = triggeringCommentId === null || triggeringCommentId === undefined ? null : String(triggeringCommentId);
  const evaluated = [];
  const stale = [];
  let readyToMergePosted = false;

  for (const comment of [...(comments ?? [])].sort(byCreation)) {
    const login = comment?.user?.login;

    if (typeof comment?.body !== "string" || typeof login !== "string") {
      continue;
    }

    const inWindow = timeOf(comment.created_at) >= history.windowStart;

    if (isBotUser(comment.user)) {
      if (inWindow && comment.body.includes(READY_TO_MERGE_PHRASE) && await isAutomationActor(login)) {
        readyToMergePosted = true;
      }
      continue;
    }

    const lines = findCommandLines(comment.body);

    if (lines.length === 0) {
      continue;
    }

    const isTriggering = mode === "command" && triggeringId !== null && String(comment.id) === triggeringId;
    const noteKind = readNoteKind(comment.body);

    // A command from before the current wait never counts again, even when edited. One still marked as
    // waiting belonged to a wait that has ended since, and is finished off below.
    if (!inWindow) {
      if (noteKind === "waiting" && await isAllowedRunner(login)) {
        stale.push({ comment, lines });
      }
      continue;
    }

    if (!isTriggering && noteKind !== "waiting") {
      continue;
    }

    if (!(await isAllowedRunner(login))) {
      if (isTriggering) {
        plan.triggerRejected = { reason: "not-allowed", login };
        return plan;
      }
      continue;
    }

    evaluated.push({ comment, login, lines, noteKind, isTriggering });
  }

  // Reads every link of a comment and checks it. Returns one array per command line.
  const evaluateLinks = async (lines) => {
    const result = [];

    for (const args of lines) {
      const lineLinks = [];

      for (const link of parseWaitForMergeLinks(args, repository)) {
        const item = {
          text: link.text,
          reference: link.reference ?? null,
          display: link.reference ? formatPullRequestReference(link.reference) : null,
          state: null,
          reason: null,
        };

        if (link.error) {
          item.reason = `${echoArgument(link.text)} is not a pull request link`;
        } else if (referenceKey(link.reference) === ownKey) {
          item.reason = `${echoArgument(item.display)} is this pull request`;
        } else if (!settings.allowExternalRepositories && normalizeName(link.reference.owner) !== ownOwner) {
          item.reason = `${echoArgument(item.display)} is outside this organization`;
        } else {
          item.state = await getPullRequestState(link.reference);

          if (item.state === "missing") {
            item.reason = `${echoArgument(item.display)} does not exist`;
          }
        }

        lineLinks.push(item);
      }

      result.push(lineLinks);
    }

    return result;
  };

  // Follows other pull requests' waits from `start`. Returns the chain [start, ...] whose last pull request is
  // waiting on this one, or null.
  let loopLookups = 0;
  const findLoop = async (start) => {
    const queue = [[start]];
    const seen = new Set([referenceKey(start)]);

    while (queue.length > 0) {
      const chain = queue.shift();

      if (loopLookups >= LOOP_SEARCH_LIMIT) {
        return null;
      }

      loopLookups += 1;

      for (const next of await findActiveWaitLinks(chain.at(-1))) {
        const key = referenceKey(next);

        if (key === ownKey) {
          return chain;
        }

        if (!seen.has(key) && chain.length < LOOP_SEARCH_DEPTH) {
          seen.add(key);
          queue.push([...chain, next]);
        }
      }
    }

    return null;
  };

  for (const entry of evaluated) {
    entry.links = await evaluateLinks(entry.lines);
    const items = entry.links.flat();

    if (entry.isTriggering && !items.some((item) => item.reason)) {
      const chains = new Map();

      for (const item of items) {
        if (!PENDING_STATES.has(item.state)) {
          continue;
        }

        const key = referenceKey(item.reference);

        if (!chains.has(key)) {
          chains.set(key, await findLoop(item.reference));
        }

        const chain = chains.get(key);

        if (chain) {
          const through = chain.slice(1).map((reference) => echoArgument(formatPullRequestReference(reference)));
          item.reason = `${echoArgument(item.display)} already waits on this pull request${through.length > 0 ? ` through ${through.join(" → ")}` : ""}`;
        }
      }
    }

    entry.reasons = unique(items.filter((item) => item.reason).map((item) => item.reason));

    if (items.length === 0) {
      entry.reasons.push("no pull request link was given");
    }

    if (entry.reasons.length > 0) {
      entry.status = "rejected";
    } else if (items.some((item) => PENDING_STATES.has(item.state))) {
      entry.status = "waiting";
    } else if (entry.noteKind === "waiting") {
      entry.status = "satisfied";
    } else {
      entry.status = "rejected";
      entry.reasons.push("every linked pull request is already merged or closed");
    }
  }

  const active = evaluated.filter((entry) => entry.status === "waiting" || entry.status === "satisfied");
  const pending = active.some((entry) => entry.status === "waiting");
  const triggeringWaiting = active.some((entry) => entry.isTriggering && entry.status === "waiting");
  plan.runners = uniqueLogins(active.map((entry) => entry.login));

  const dependencies = new Map();

  for (const item of active.flatMap((entry) => entry.links.flat())) {
    dependencies.set(referenceKey(item.reference), { reference: item.reference, display: item.display, state: item.state });
  }

  plan.dependencies = [...dependencies.values()];

  if (pending) {
    if (!presentLabel || manualLabel) {
      // A hand-added label is taken back and, when this command starts a wait, added again by Label Sync.
      plan.removeLabel = manualLabel ? presentLabel.name : null;
      plan.addLabel = triggeringWaiting;
      plan.status = triggeringWaiting ? "waiting" : "not-waiting";
    } else {
      plan.status = "waiting";
    }
  } else if (active.length > 0 && presentLabel && !manualLabel) {
    plan.status = "done";
    plan.removeLabel = presentLabel.name;
  } else {
    // Nothing to wait on: a wait whose commands were all edited away, deleted or rejected ends here, and a
    // label someone added by hand is taken back.
    plan.status = "idle";
    plan.removeLabel = presentLabel ? presentLabel.name : null;
  }

  const waitEnded = plan.status === "idle" && Boolean(presentLabel) && !manualLabel;

  for (const entry of evaluated) {
    let note;

    if (entry.status === "rejected") {
      const prefix = entry.noteKind === "waiting" ? (waitEnded ? "Cancelled" : "Stopped waiting") : "Not started";
      note = renderNote("rejected", `${prefix}: ${entry.reasons.join("; ")}.`);
    } else if (plan.status === "done") {
      note = renderNote("done", "Done.");
    } else {
      note = renderNote("waiting", `Waiting. Remove the **${labelName}** label to cancel.`);
    }

    const icons = entry.links.map((line) => line.map((item) => (item.reason ? ICONS.invalid : ICONS[item.state] ?? ICONS.invalid)));
    const body = renderCommentBody(entry.comment.body, icons, note);

    if (body !== entry.comment.body) {
      plan.commentEdits.push({ commentId: entry.comment.id, from: entry.comment.body, to: body, triggering: entry.isTriggering });
    }

    if (entry.isTriggering || (entry.noteKind === "waiting" && entry.status === "rejected")) {
      plan.reactions.push({ commentId: entry.comment.id, content: entry.status === "rejected" ? "-1" : "+1" });
    }
  }

  // Commands of a wait that has ended since. Cancelled by whoever removed the label, or, when Label Sync
  // removed it, done if everything they linked is merged or closed.
  for (const { comment, lines } of stale) {
    const created = timeOf(comment.created_at);
    const removal = history.removals.find((item) => item.time >= created) ?? null;
    const links = await evaluateLinks(lines);
    let note;

    if (removal && !removal.byApp) {
      note = renderNote("cancelled", removal.actor ? `Cancelled by ${removal.actor}.` : "Cancelled.");
    } else {
      const items = links.flat().filter((item) => !item.reason);
      note = items.length > 0 && items.every((item) => FINISHED_STATES.has(item.state))
        ? renderNote("done", "Done.")
        : renderNote("cancelled", "Cancelled.");
    }

    const icons = links.map((line) => line.map((item) => (item.reason ? ICONS.invalid : ICONS[item.state] ?? ICONS.invalid)));
    const body = renderCommentBody(comment.body, icons, note);

    if (body !== comment.body) {
      plan.commentEdits.push({ commentId: comment.id, from: comment.body, to: body, triggering: false });
    }
  }

  if (plan.status === "done" && !readyToMergePosted && await isApproved()) {
    plan.readyToMergeComment = { body: renderReadyToMergeBody(plan.runners) };
  }

  return plan;
}
