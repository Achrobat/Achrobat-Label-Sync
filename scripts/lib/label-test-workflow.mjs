import { normalizeName, normalizeRepositoryRef } from "./config-utils.mjs";

function labelNames(labels) {
  return new Map(
    labels
      .filter((label) => label && typeof label.name === "string")
      .map((label) => [normalizeName(label.name), label.name]),
  );
}

function reviewTime(review) {
  const submittedAt = Date.parse(review.submitted_at ?? "");
  return Number.isNaN(submittedAt) ? 0 : submittedAt;
}

function reviewId(review) {
  return Number.isFinite(review.id) ? review.id : 0;
}

export function collapseLatestReviewStates(reviews) {
  const latest = new Map();

  for (const review of reviews) {
    const login = review?.user?.login;

    if (!login || typeof review.state !== "string") {
      continue;
    }

    const key = normalizeName(login);
    const previous = latest.get(key);
    const nextTime = reviewTime(review);
    const previousTime = previous ? reviewTime(previous.review) : -1;
    const nextId = reviewId(review);
    const previousId = previous ? reviewId(previous.review) : -1;

    if (!previous || nextTime > previousTime || (nextTime === previousTime && nextId > previousId)) {
      latest.set(key, {
        login,
        state: review.state,
        review,
      });
    }
  }

  return new Map(
    [...latest.entries()].map(([key, value]) => [
      key,
      {
        login: value.login,
        state: value.state,
      },
    ]),
  );
}

function protectedApproversByLabel(protectedLabelApprovals) {
  const byLabel = new Map();

  for (const entry of protectedLabelApprovals) {
    const key = normalizeName(entry.label);
    const entries = byLabel.get(key) ?? [];
    entries.push(entry.approver);
    byLabel.set(key, entries);
  }

  return byLabel;
}

function formatApprovers(approvers) {
  return approvers.map((approver) => approver.value).join(", ");
}

async function hasAcceptedProtectedApproval(approvers, approvedReviews, isTeamMember) {
  for (const approver of approvers) {
    if (approver.type === "user" && approvedReviews.has(normalizeName(approver.login))) {
      return true;
    }

    if (approver.type === "team") {
      for (const review of approvedReviews.values()) {
        if (await isTeamMember(approver.slug, review.login)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function isIgnoredPullRequestAuthor(config, pullRequestAuthor) {
  if (typeof pullRequestAuthor !== "string") {
    return false;
  }

  return (config.ignoredPullRequestAuthors ?? [])
    .some((author) => normalizeName(author) === normalizeName(pullRequestAuthor));
}

function stickyRemoversByLabel(stickyLabels) {
  const byLabel = new Map();

  for (const entry of stickyLabels) {
    const key = normalizeName(entry.label);
    const existing = byLabel.get(key) ?? { label: entry.label, removers: [] };
    existing.removers.push(entry.remover);
    byLabel.set(key, existing);
  }

  return byLabel;
}

function eventTime(event) {
  const createdAt = Date.parse(event?.created_at ?? "");
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function eventId(event) {
  return Number.isFinite(event?.id) ? event.id : 0;
}

function latestLabelEvents(labelEvents) {
  const latest = new Map();

  for (const event of labelEvents ?? []) {
    if (
      (event?.event !== "labeled" && event?.event !== "unlabeled")
      || typeof event.label?.name !== "string"
    ) {
      continue;
    }

    const key = normalizeName(event.label.name);
    const previous = latest.get(key);

    if (
      !previous
      || eventTime(event) > eventTime(previous)
      || (eventTime(event) === eventTime(previous) && eventId(event) > eventId(previous))
    ) {
      latest.set(key, event);
    }
  }

  return latest;
}

async function isAuthorizedMember(members, login, isTeamMember) {
  if (typeof login !== "string" || !login) {
    return false;
  }

  for (const member of members) {
    if (member.type === "user" && normalizeName(member.login) === normalizeName(login)) {
      return true;
    }

    if (member.type === "team" && await isTeamMember(member.slug, login)) {
      return true;
    }
  }

  return false;
}

// Finds sticky labels that are missing from the pull request because someone who is not a configured
// remover took them off. The issue timeline is the source of truth: for each missing sticky label, the
// latest labeled/unlabeled event decides whether it was removed and by whom. The triggering
// pull_request_target "unlabeled" payload is only used when the timeline does not show that removal yet,
// which covers GitHub's short delay before new timeline events become visible.
//
// Removals made by the Label Sync automation identity (the configured PAT owner or GitHub App bot) are
// always accepted. Only admins can run Label Sync workflows such as Remove-Labels, so those removals
// take precedence over the configured removers.
export async function findStickyLabelsToRestore({
  config,
  prLabels,
  labelEvents,
  triggeringEvent,
  isTeamMember,
  isAutomationActor = async () => false,
}) {
  const stickyLabels = config.stickyLabels ?? [];

  if (stickyLabels.length === 0) {
    return [];
  }

  const presentLabels = labelNames(prLabels);
  const latestEvents = latestLabelEvents(labelEvents);
  const restorations = [];

  for (const [labelKey, sticky] of stickyRemoversByLabel(stickyLabels).entries()) {
    if (presentLabels.has(labelKey)) {
      continue;
    }

    let removal = null;
    const latestEvent = latestEvents.get(labelKey);

    if (latestEvent?.event === "unlabeled") {
      removal = {
        label: latestEvent.label.name,
        removedBy: latestEvent.actor?.login ?? null,
      };
    } else if (
      triggeringEvent?.action === "unlabeled"
      && typeof triggeringEvent.label === "string"
      && normalizeName(triggeringEvent.label) === labelKey
    ) {
      removal = {
        label: triggeringEvent.label,
        removedBy: triggeringEvent.sender || null,
      };
    }

    if (removal === null) {
      continue;
    }

    if (removal.removedBy && await isAutomationActor(removal.removedBy)) {
      continue;
    }

    if (await isAuthorizedMember(sticky.removers, removal.removedBy, isTeamMember)) {
      continue;
    }

    restorations.push({
      label: removal.label,
      removedBy: removal.removedBy,
      removers: sticky.removers,
    });
  }

  return restorations;
}

export function formatStickyRestoration(restoration) {
  const actor = restoration.removedBy ? `@${restoration.removedBy}` : "an unknown user";
  return `Sticky label "${restoration.label}" was removed by ${actor} and has been restored. `
    + `Only ${formatApprovers(restoration.removers)} can remove it.`;
}

function describeRemover(remover) {
  return remover.type === "team" ? `the ${remover.slug} team` : remover.login;
}

function joinWithOr(values) {
  if (values.length <= 1) {
    return values.join("");
  }

  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function stickyLabelNoticePrefix(label) {
  return `The **${label}** label is sticky`;
}

// The notice is posted only once per label on each pull request. Earlier notices are recognized by their
// opening text, ignoring case, so changing the configured removers does not cause a second notice.
export function hasStickyLabelComment(comments, label) {
  const prefix = stickyLabelNoticePrefix(label).toLowerCase();
  return (comments ?? []).some(
    (comment) => typeof comment?.body === "string" && comment.body.toLowerCase().includes(prefix),
  );
}

// Builds one comment for the restored labels that have not been announced on this pull request yet.
// Users and teams are written without "@" so the notice does not ping the removers.
export function buildStickyLabelComment(restorations, comments) {
  const pending = [];
  const seen = new Set();

  for (const restoration of restorations) {
    const key = normalizeName(restoration.label);

    if (seen.has(key) || hasStickyLabelComment(comments, restoration.label)) {
      continue;
    }

    seen.add(key);
    pending.push(restoration);
  }

  if (pending.length === 0) {
    return null;
  }

  return pending
    .map((restoration) => `${stickyLabelNoticePrefix(restoration.label)} and can only be removed by ${joinWithOr(restoration.removers.map(describeRemover))}.`)
    .join("\n\n");
}

export async function evaluatePrLabelTest({
  config,
  targetRepository,
  pullRequestAuthor,
  prLabels,
  reviews,
  isTeamMember,
}) {
  if (isIgnoredPullRequestAuthor(config, pullRequestAuthor)) {
    return {
      passed: true,
      failures: [],
    };
  }

  const failures = [];
  const presentLabels = labelNames(prLabels);
  const repositoryRules = targetRepository
    ? config.repositoryLabels?.get(normalizeRepositoryRef(targetRepository))
    : undefined;
  const requiredLabels = [
    ...(config.requiredLabels ?? []),
    ...(repositoryRules?.requiredLabels ?? []),
  ];
  const failingLabels = [
    ...(config.failingLabels ?? []),
    ...(repositoryRules?.failingLabels ?? []),
  ];
  const protectedLabelApprovals = config.protectedLabelApprovals ?? [];

  if (
    requiredLabels.length > 0
    && !requiredLabels.some((label) => presentLabels.has(normalizeName(label)))
  ) {
    failures.push(`PR must have at least one required label: ${requiredLabels.join(", ")}.`);
  }

  for (const label of failingLabels) {
    if (presentLabels.has(normalizeName(label))) {
      failures.push(`PR has failing label "${label}".`);
    }
  }

  const latestReviews = collapseLatestReviewStates(reviews);
  const approvedReviews = new Map(
    [...latestReviews.entries()].filter(([, review]) => review.state === "APPROVED"),
  );
  const approversByLabel = protectedApproversByLabel(protectedLabelApprovals);

  for (const [labelKey, approvers] of approversByLabel.entries()) {
    if (!presentLabels.has(labelKey)) {
      continue;
    }

    if (!(await hasAcceptedProtectedApproval(approvers, approvedReviews, isTeamMember))) {
      failures.push(
        `Protected label "${presentLabels.get(labelKey)}" requires approval from one of: ${formatApprovers(approvers)}.`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

function reviewerKey(member) {
  return member.type === "team" ? `team:${normalizeName(member.slug)}` : `user:${normalizeName(member.login)}`;
}

function timelineReviewerKey(event) {
  if (typeof event?.requested_team?.slug === "string") {
    return `team:${normalizeName(event.requested_team.slug)}`;
  }

  if (typeof event?.requested_reviewer?.login === "string") {
    return `user:${normalizeName(event.requested_reviewer.login)}`;
  }

  return null;
}

function latestApprovedReviews(reviews) {
  const latest = new Map();

  for (const review of reviews ?? []) {
    const login = review?.user?.login;

    if (!login || typeof review.state !== "string") {
      continue;
    }

    const key = normalizeName(login);
    const previous = latest.get(key);

    if (
      !previous
      || reviewTime(review) > reviewTime(previous)
      || (reviewTime(review) === reviewTime(previous) && reviewId(review) > reviewId(previous))
    ) {
      latest.set(key, review);
    }
  }

  return [...latest.values()]
    .filter((review) => review.state === "APPROVED")
    .map((review) => ({ login: review.user.login, submittedAt: reviewTime(review) }));
}

function latestLabeledTime(labelEvents, labelKey) {
  let latest = 0;

  for (const event of labelEvents ?? []) {
    if (
      event?.event === "labeled"
      && typeof event.label?.name === "string"
      && normalizeName(event.label.name) === labelKey
    ) {
      latest = Math.max(latest, eventTime(event));
    }
  }

  return latest;
}

function reviewRequestEvents(labelEvents) {
  const byReviewer = new Map();

  for (const event of labelEvents ?? []) {
    if (event?.event !== "review_requested") {
      continue;
    }

    const key = timelineReviewerKey(event);

    if (key === null) {
      continue;
    }

    const events = byReviewer.get(key) ?? [];
    events.push(event);
    byReviewer.set(key, events);
  }

  for (const events of byReviewer.values()) {
    events.sort((left, right) => eventTime(left) - eventTime(right) || eventId(left) - eventId(right));
  }

  return byReviewer;
}

export function describeReviewer(member) {
  return member.type === "team" ? `teams/${member.slug}` : member.login;
}

// Decides which review requests Label Test should make or withdraw. The decision only looks at the
// current pull request state (labels, latest reviews, pending requests and the issue timeline), so it
// gives the same answer whether it runs from a label event, a review-triggered rerun or a new push.
//
// A reviewer is requested once per "anchor": the latest time the label was applied, and for
// "afterApproval" entries also the newest approval that triggers the request. If the timeline already
// shows a review request for that reviewer at or after the anchor, nothing is requested again. That keeps
// Label Test from re-requesting a team after GitHub clears the request when a member reviews, and from
// overriding a person who removed the request by hand.
//
// When the label is gone, a still-pending request is withdrawn only if Label Sync made it and no label
// that is still present maps to the same reviewer.
export async function planReviewRequests({
  config,
  prLabels,
  reviews,
  labelEvents,
  pendingReviewers = { users: [], teams: [] },
  pullRequestAuthor,
  isDraft = false,
  isTeamMember,
  isAutomationActor = async () => false,
}) {
  const plan = { request: [], withdraw: [] };
  const entries = config.reviewRequests ?? [];

  if (entries.length === 0 || isIgnoredPullRequestAuthor(config, pullRequestAuthor)) {
    return plan;
  }

  const presentLabels = labelNames(prLabels);
  const pending = new Set([
    ...(pendingReviewers.users ?? []).map((login) => `user:${normalizeName(login)}`),
    ...(pendingReviewers.teams ?? []).map((slug) => `team:${normalizeName(slug)}`),
  ]);
  const requestEvents = reviewRequestEvents(labelEvents);
  const approvals = latestApprovedReviews(reviews);
  const retainedReviewers = new Set();
  const plannedRequests = new Set();

  for (const entry of entries) {
    const labelKey = normalizeName(entry.label);

    if (!presentLabels.has(labelKey)) {
      continue;
    }

    const key = reviewerKey(entry.reviewer);
    retainedReviewers.add(key);

    if (isDraft || plannedRequests.has(key) || pending.has(key)) {
      continue;
    }

    if (
      entry.reviewer.type === "user"
      && typeof pullRequestAuthor === "string"
      && normalizeName(entry.reviewer.login) === normalizeName(pullRequestAuthor)
    ) {
      continue;
    }

    let hasQualifyingApproval = false;
    const outsideApprovals = [];

    for (const approval of approvals) {
      if (await isAuthorizedMember([entry.reviewer], approval.login, isTeamMember)) {
        hasQualifyingApproval = true;
        break;
      }

      outsideApprovals.push(approval);
    }

    if (hasQualifyingApproval) {
      continue;
    }

    let anchor = latestLabeledTime(labelEvents, labelKey);
    let triggeredBy = null;

    if (entry.when === "afterApproval") {
      for (const approval of outsideApprovals) {
        if (
          entry.approvedBy.length > 0
          && !(await isAuthorizedMember(entry.approvedBy, approval.login, isTeamMember))
        ) {
          continue;
        }

        if (triggeredBy === null || approval.submittedAt > triggeredBy.submittedAt) {
          triggeredBy = approval;
        }
      }

      if (triggeredBy === null) {
        continue;
      }

      anchor = Math.max(anchor, triggeredBy.submittedAt);
    }

    const alreadyRequested = (requestEvents.get(key) ?? []).some((event) => eventTime(event) >= anchor);

    if (alreadyRequested) {
      continue;
    }

    plannedRequests.add(key);
    plan.request.push({
      label: presentLabels.get(labelKey),
      reviewer: entry.reviewer,
      when: entry.when,
      approvedBy: triggeredBy?.login ?? null,
    });
  }

  const withdrawn = new Set();

  for (const entry of entries) {
    const key = reviewerKey(entry.reviewer);

    if (
      presentLabels.has(normalizeName(entry.label))
      || retainedReviewers.has(key)
      || withdrawn.has(key)
      || !pending.has(key)
    ) {
      continue;
    }

    const latestRequest = (requestEvents.get(key) ?? []).at(-1);
    const requester = latestRequest?.review_requester?.login ?? latestRequest?.actor?.login;

    if (!requester || !(await isAutomationActor(requester))) {
      continue;
    }

    withdrawn.add(key);
    plan.withdraw.push({
      label: entry.label,
      reviewer: entry.reviewer,
    });
  }

  return plan;
}

export function formatReviewRequest(request) {
  const reason = request.when === "afterApproval" && request.approvedBy
    ? `"${request.label}" is on the PR and @${request.approvedBy} approved`
    : `"${request.label}" is on the PR`;
  return `Requested review from ${describeReviewer(request.reviewer)} because ${reason}.`;
}

export function formatReviewWithdrawal(withdrawal) {
  return `Withdrew the review request for ${describeReviewer(withdrawal.reviewer)} because "${withdrawal.label}" was removed.`;
}
