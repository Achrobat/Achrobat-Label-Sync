import { normalizeName } from "./config-utils.mjs";

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

export async function evaluatePrLabelTest({
  config,
  prLabels,
  reviews,
  isTeamMember,
}) {
  const failures = [];
  const presentLabels = labelNames(prLabels);
  const requiredLabels = config.requiredLabels ?? [];
  const failingLabels = config.failingLabels ?? [];
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
