import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStickyLabelComment,
  collapseLatestReviewStates,
  evaluatePrLabelTest,
  findStickyLabelsToRestore,
  formatReviewRequest,
  formatReviewWithdrawal,
  formatStickyRestoration,
  isIgnoredPullRequestAuthor,
  planReviewRequests,
} from "../scripts/lib/label-test-workflow.mjs";

const emptyConfig = {
  requiredLabels: [],
  failingLabels: [],
  ignoredPullRequestAuthors: [],
  protectedLabelApprovals: [],
  stickyLabels: [],
  repositoryLabels: new Map(),
};

test("evaluatePrLabelTest passes when required labels are empty and no blocking rules match", async () => {
  const result = await evaluatePrLabelTest({
    config: emptyConfig,
    prLabels: [],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest requires at least one configured required label when the list is not empty", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      requiredLabels: ["Bug", "Feature"],
    },
    prLabels: [{ name: "Documentation" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'PR must have at least one required label: Bug, Feature.',
  ]);
});

test("evaluatePrLabelTest lets failing labels override matching required labels", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      requiredLabels: ["Bug"],
      failingLabels: ["Blocked"],
    },
    prLabels: [{ name: "Bug" }, { name: "Blocked" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'PR has failing label "Blocked".',
  ]);
});

test("evaluatePrLabelTest passes an ignored pull request author without applying label rules", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      requiredLabels: ["Bug"],
      failingLabels: ["Blocked"],
      ignoredPullRequestAuthors: ["github-actions[bot]"],
    },
    pullRequestAuthor: "GitHub-Actions[bot]",
    prLabels: [{ name: "Blocked" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest accepts a repository-specific required label", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      requiredLabels: ["Bug"],
      repositoryLabels: new Map([
        ["example/special-repo", {
          requiredLabels: ["Repo Feature"],
          failingLabels: [],
        }],
      ]),
    },
    targetRepository: "example/special-repo",
    prLabels: [{ name: "Repo Feature" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest rejects a repository-specific failing label", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      repositoryLabels: new Map([
        ["example/special-repo", {
          requiredLabels: [],
          failingLabels: ["Repo: Do Not Merge"],
        }],
      ]),
    },
    targetRepository: "EXAMPLE/SPECIAL-REPO",
    prLabels: [{ name: "Repo: Do Not Merge" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'PR has failing label "Repo: Do Not Merge".',
  ]);
});

test("evaluatePrLabelTest ignores label rules configured for another repository", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      repositoryLabels: new Map([
        ["example/special-repo", {
          requiredLabels: ["Repo Feature"],
          failingLabels: ["Repo: Do Not Merge"],
        }],
      ]),
    },
    targetRepository: "example/ordinary-repo",
    prLabels: [{ name: "Repo: Do Not Merge" }],
    reviews: [],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest accepts a protected label approval from a configured user", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      protectedLabelApprovals: [
        { label: "Affects Balance", approver: { type: "user", login: "UltraProdigy", value: "UltraProdigy" } },
      ],
    },
    prLabels: [{ name: "Affects Balance" }],
    reviews: [
      { user: { login: "UltraProdigy" }, state: "APPROVED", submitted_at: "2026-07-04T12:00:00Z", id: 1 },
    ],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest accepts a protected label approval from a configured team member", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      protectedLabelApprovals: [
        { label: "Affects Balance", approver: { type: "team", slug: "admin", value: "teams/admin" } },
      ],
    },
    prLabels: [{ name: "Affects Balance" }],
    reviews: [
      { user: { login: "Maintainer" }, state: "APPROVED", submitted_at: "2026-07-04T12:00:00Z", id: 1 },
    ],
    isTeamMember: async (teamSlug, login) => teamSlug === "admin" && login === "Maintainer",
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("evaluatePrLabelTest rejects protected labels without a current accepted approval", async () => {
  const result = await evaluatePrLabelTest({
    config: {
      ...emptyConfig,
      protectedLabelApprovals: [
        { label: "Affects Balance", approver: { type: "user", login: "UltraProdigy", value: "UltraProdigy" } },
      ],
    },
    prLabels: [{ name: "Affects Balance" }],
    reviews: [
      { user: { login: "UltraProdigy" }, state: "APPROVED", submitted_at: "2026-07-04T12:00:00Z", id: 1 },
      { user: { login: "UltraProdigy" }, state: "CHANGES_REQUESTED", submitted_at: "2026-07-04T13:00:00Z", id: 2 },
    ],
    isTeamMember: async () => false,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'Protected label "Affects Balance" requires approval from one of: UltraProdigy.',
  ]);
});

test("collapseLatestReviewStates keeps only each reviewer's latest state", () => {
  const states = collapseLatestReviewStates([
    { user: { login: "Reviewer" }, state: "APPROVED", submitted_at: "2026-07-04T12:00:00Z", id: 1 },
    { user: { login: "Reviewer" }, state: "COMMENTED", submitted_at: "2026-07-04T12:00:00Z", id: 2 },
    { user: { login: "Other" }, state: "APPROVED", submitted_at: "2026-07-04T11:00:00Z", id: 3 },
  ]);

  assert.deepEqual([...states.entries()], [
    ["reviewer", { login: "Reviewer", state: "COMMENTED" }],
    ["other", { login: "Other", state: "APPROVED" }],
  ]);
});

const stickyConfig = {
  ...emptyConfig,
  stickyLabels: [
    { label: "Affects Balance", remover: { type: "team", slug: "admin", value: "teams/admin" } },
    { label: "Affects Balance", remover: { type: "user", login: "UltraProdigy", value: "UltraProdigy" } },
  ],
};

function labelEvent(event, label, actor, createdAt, id) {
  return { id, event, label: { name: label }, actor: { login: actor }, created_at: createdAt };
}

const isAdmin = async (teamSlug, login) => teamSlug === "admin" && login === "Maintainer";

test("findStickyLabelsToRestore restores a sticky label removed by someone who is not a remover", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [{ name: "Bug" }],
    labelEvents: [
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-20T10:00:00Z", 1),
      labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-20T11:00:00Z", 2),
    ],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations, [
    {
      label: "Affects Balance",
      removedBy: "Contributor",
      removers: stickyConfig.stickyLabels.map((entry) => entry.remover),
    },
  ]);
  assert.equal(
    formatStickyRestoration(restorations[0]),
    'Sticky label "Affects Balance" was removed by @Contributor and has been restored. Only teams/admin, UltraProdigy can remove it.',
  );
});

test("findStickyLabelsToRestore leaves a sticky label off when a configured user removed it", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-20T10:00:00Z", 1),
      labelEvent("unlabeled", "affects balance", "ultraprodigy", "2026-09-20T11:00:00Z", 2),
    ],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations, []);
});

test("findStickyLabelsToRestore leaves a sticky label off when a configured team member removed it", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-20T10:00:00Z", 1),
      labelEvent("unlabeled", "Affects Balance", "Maintainer", "2026-09-20T11:00:00Z", 2),
    ],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations, []);
});

test("findStickyLabelsToRestore ignores sticky labels that were never applied or are still present", async () => {
  const neverApplied = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [{ name: "Bug" }],
    labelEvents: [labelEvent("labeled", "Bug", "Contributor", "2026-09-20T10:00:00Z", 1)],
    isTeamMember: isAdmin,
  });
  const stillPresent = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [{ name: "affects balance" }],
    labelEvents: [
      labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-20T11:00:00Z", 2),
      labelEvent("labeled", "Affects Balance", "label-sync-app[bot]", "2026-09-20T11:00:05Z", 3),
    ],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(neverApplied, []);
  assert.deepEqual(stillPresent, []);
});

test("findStickyLabelsToRestore uses the latest label event regardless of API ordering", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [
      labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-21T09:00:00Z", 5),
      labelEvent("unlabeled", "Affects Balance", "Maintainer", "2026-09-20T11:00:00Z", 2),
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-21T08:00:00Z", 4),
    ],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations.map((restoration) => restoration.removedBy), ["Contributor"]);
});

test("findStickyLabelsToRestore falls back to the triggering unlabeled event when the timeline lags", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-20T10:00:00Z", 1)],
    triggeringEvent: { action: "unlabeled", label: "Affects Balance", sender: "Contributor" },
    isTeamMember: isAdmin,
  });
  const authorizedTrigger = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [],
    triggeringEvent: { action: "unlabeled", label: "Affects Balance", sender: "Maintainer" },
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations.map((restoration) => restoration.label), ["Affects Balance"]);
  assert.deepEqual(authorizedTrigger, []);
});

test("findStickyLabelsToRestore trusts a timeline removal over a stale triggering event", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-09-20T10:00:00Z", 1),
      labelEvent("unlabeled", "Affects Balance", "Maintainer", "2026-09-20T12:00:00Z", 3),
    ],
    triggeringEvent: { action: "unlabeled", label: "Affects Balance", sender: "Contributor" },
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations, []);
});

test("findStickyLabelsToRestore treats a removal by a deleted account as unauthorized", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [
      { id: 2, event: "unlabeled", label: { name: "Affects Balance" }, actor: null, created_at: "2026-09-20T11:00:00Z" },
    ],
    isTeamMember: isAdmin,
  });

  assert.equal(restorations.length, 1);
  assert.match(formatStickyRestoration(restorations[0]), /removed by an unknown user/);
});

test("findStickyLabelsToRestore does nothing when no sticky labels are configured", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: emptyConfig,
    prLabels: [],
    labelEvents: [labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-20T11:00:00Z", 2)],
    isTeamMember: isAdmin,
  });

  assert.deepEqual(restorations, []);
});

test("a restored sticky protected label keeps the policy failing until an approver approves", async () => {
  const config = {
    ...stickyConfig,
    protectedLabelApprovals: [
      { label: "Affects Balance", approver: { type: "team", slug: "admin", value: "teams/admin" } },
    ],
  };
  const restorations = await findStickyLabelsToRestore({
    config,
    prLabels: [],
    labelEvents: [labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-20T11:00:00Z", 2)],
    isTeamMember: isAdmin,
  });
  const result = await evaluatePrLabelTest({
    config,
    prLabels: restorations.map((restoration) => ({ name: restoration.label })),
    reviews: [],
    isTeamMember: isAdmin,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'Protected label "Affects Balance" requires approval from one of: teams/admin.',
  ]);
});

test("isIgnoredPullRequestAuthor matches configured authors case-insensitively", () => {
  const config = { ...emptyConfig, ignoredPullRequestAuthors: ["github-actions[bot]"] };

  assert.equal(isIgnoredPullRequestAuthor(config, "GitHub-Actions[bot]"), true);
  assert.equal(isIgnoredPullRequestAuthor(config, "Contributor"), false);
  assert.equal(isIgnoredPullRequestAuthor(config, undefined), false);
});

test("findStickyLabelsToRestore accepts removals by the Label Sync automation identity", async () => {
  const checked = [];
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [labelEvent("unlabeled", "Affects Balance", "label-sync-app[bot]", "2026-09-20T11:00:00Z", 2)],
    isTeamMember: async (teamSlug, login) => {
      checked.push(login);
      return false;
    },
    isAutomationActor: async (login) => login === "label-sync-app[bot]",
  });

  assert.deepEqual(restorations, []);
  assert.deepEqual(checked, []);
});

test("findStickyLabelsToRestore still restores removals by other users when an automation identity is known", async () => {
  const restorations = await findStickyLabelsToRestore({
    config: stickyConfig,
    prLabels: [],
    labelEvents: [labelEvent("unlabeled", "Affects Balance", "Contributor", "2026-09-20T11:00:00Z", 2)],
    isTeamMember: isAdmin,
    isAutomationActor: async (login) => login === "label-sync-app[bot]",
  });

  assert.deepEqual(restorations.map((restoration) => restoration.removedBy), ["Contributor"]);
});

const balanceRestoration = {
  label: "Affects Balance",
  removedBy: "Contributor",
  removers: stickyConfig.stickyLabels.map((entry) => entry.remover),
};

test("buildStickyLabelComment writes a notice naming the removers without pinging them", () => {
  const body = buildStickyLabelComment([balanceRestoration], []);

  assert.equal(
    body,
    "The **Affects Balance** label is sticky and can only be removed by the admin team or UltraProdigy.",
  );
  assert.doesNotMatch(body, /@|<!--/);
});

test("buildStickyLabelComment only posts the notice for the first removal of each label", () => {
  const previousComments = [
    { body: "Please take a look." },
    { body: "The **affects balance** label is sticky and can only be removed by someone who has since changed." },
  ];

  assert.equal(buildStickyLabelComment([balanceRestoration], previousComments), null);
});

test("buildStickyLabelComment recognizes notices posted with the earlier hidden marker format", () => {
  const previousComments = [
    {
      body: "<!-- label-sync:sticky-label:affects%20balance -->\n"
        + "The **Affects Balance** label is sticky and can only be removed by the admin team.",
    },
  ];

  assert.equal(buildStickyLabelComment([balanceRestoration], previousComments), null);
});

test("buildStickyLabelComment combines new notices and skips labels that were already announced", () => {
  const blocked = {
    label: "Needs Design",
    removedBy: "Contributor",
    removers: [
      { type: "user", login: "Lead", value: "Lead" },
      { type: "team", slug: "design", value: "teams/design" },
      { type: "user", login: "label-sync-app[bot]", value: "label-sync-app[bot]" },
    ],
  };
  const body = buildStickyLabelComment(
    [balanceRestoration, blocked],
    [{ body: "The **Affects Balance** label is sticky and can only be removed by the admin team." }],
  );

  assert.equal(
    body,
    "The **Needs Design** label is sticky and can only be removed by Lead, the design team, or label-sync-app[bot].",
  );
});

const adminTeam = { type: "team", slug: "admin", value: "teams/admin" };
const balanceTeam = { type: "team", slug: "balance-team", value: "teams/balance-team" };
const developersTeam = { type: "team", slug: "developers", value: "teams/developers" };

function reviewRequestConfig(reviewRequests) {
  return { ...emptyConfig, reviewRequests };
}

const reviewRequestEntries = [
  { label: "Requires Admin", reviewer: adminTeam, when: "labeled", approvedBy: [] },
  { label: "Affects Balance", reviewer: balanceTeam, when: "afterApproval", approvedBy: [] },
];

const teamMembers = {
  admin: ["AdminUser"],
  "balance-team": ["BalanceUser", "DevAndBalance"],
  developers: ["DevUser", "DevAndBalance"],
};

async function isConfiguredTeamMember(slug, login) {
  return (teamMembers[slug] ?? []).some((member) => member.toLowerCase() === login.toLowerCase());
}

function review(login, state, submittedAt, id) {
  return { id, user: { login }, state, submitted_at: submittedAt };
}

function reviewRequestedEvent({ team, user, requester, createdAt, id }) {
  return {
    id,
    event: "review_requested",
    created_at: createdAt,
    actor: { login: requester },
    review_requester: { login: requester },
    ...(team ? { requested_team: { slug: team } } : {}),
    ...(user ? { requested_reviewer: { login: user } } : {}),
  };
}

const isLabelSync = async (login) => login === "label-sync-app[bot]";

test("planReviewRequests requests the reviewer as soon as a labeled entry's label is present", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "requires admin" }],
    reviews: [],
    labelEvents: [labelEvent("labeled", "Requires Admin", "Contributor", "2026-10-18T10:00:00Z", 1)],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan, {
    request: [{ label: "requires admin", reviewer: adminTeam, when: "labeled", approvedBy: null }],
    withdraw: [],
  });
  assert.equal(
    formatReviewRequest(plan.request[0]),
    'Requested review from teams/admin because "requires admin" is on the PR.',
  );
});

test("planReviewRequests waits for an outside approval before requesting an afterApproval reviewer", async () => {
  const base = {
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "Affects Balance" }],
    labelEvents: [labelEvent("labeled", "Affects Balance", "Contributor", "2026-10-18T10:00:00Z", 1)],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  };

  const beforeApproval = await planReviewRequests({
    ...base,
    reviews: [review("DevUser", "COMMENTED", "2026-10-18T11:00:00Z", 10)],
  });
  assert.deepEqual(beforeApproval.request, []);

  const afterApproval = await planReviewRequests({
    ...base,
    reviews: [review("DevUser", "APPROVED", "2026-10-18T11:00:00Z", 10)],
  });
  assert.deepEqual(afterApproval.request, [
    { label: "Affects Balance", reviewer: balanceTeam, when: "afterApproval", approvedBy: "DevUser" },
  ]);
  assert.equal(
    formatReviewRequest(afterApproval.request[0]),
    'Requested review from teams/balance-team because "Affects Balance" is on the PR and @DevUser approved.',
  );
});

test("planReviewRequests skips the request when a reviewer team member already approved", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "Affects Balance" }, { name: "Requires Admin" }],
    reviews: [
      review("DevAndBalance", "APPROVED", "2026-10-18T11:00:00Z", 10),
      review("AdminUser", "APPROVED", "2026-10-18T11:05:00Z", 11),
    ],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan, { request: [], withdraw: [] });
});

test("planReviewRequests ignores approvals that were later dismissed or replaced", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "Affects Balance" }],
    reviews: [
      review("DevUser", "APPROVED", "2026-10-18T11:00:00Z", 10),
      review("DevUser", "DISMISSED", "2026-10-18T12:00:00Z", 11),
    ],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan.request, []);
});

test("planReviewRequests only counts approvals from approvedBy when it is set", async () => {
  const config = reviewRequestConfig([
    { label: "Affects Balance", reviewer: balanceTeam, when: "afterApproval", approvedBy: [developersTeam] },
  ]);
  const base = {
    config,
    prLabels: [{ name: "Affects Balance" }],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  };

  const outsider = await planReviewRequests({
    ...base,
    reviews: [review("RandomUser", "APPROVED", "2026-10-18T11:00:00Z", 10)],
  });
  assert.deepEqual(outsider.request, []);

  const developer = await planReviewRequests({
    ...base,
    reviews: [
      review("RandomUser", "APPROVED", "2026-10-18T11:00:00Z", 10),
      review("DevUser", "APPROVED", "2026-10-18T10:00:00Z", 11),
    ],
  });
  assert.equal(developer.request[0].approvedBy, "DevUser");
});

test("planReviewRequests does not request again after a request at or after the anchor", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "Affects Balance" }, { name: "Requires Admin" }],
    reviews: [review("DevUser", "APPROVED", "2026-10-18T11:00:00Z", 10)],
    labelEvents: [
      labelEvent("labeled", "Requires Admin", "Contributor", "2026-10-18T10:00:00Z", 1),
      labelEvent("labeled", "Affects Balance", "Contributor", "2026-10-18T10:00:00Z", 2),
      reviewRequestedEvent({ team: "admin", requester: "label-sync-app[bot]", createdAt: "2026-10-18T10:00:05Z", id: 3 }),
      reviewRequestedEvent({ team: "balance-team", requester: "label-sync-app[bot]", createdAt: "2026-10-18T11:00:05Z", id: 4 }),
    ],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan, { request: [], withdraw: [] });
});

test("planReviewRequests requests again after a newer outside approval or a re-added label", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [{ name: "Affects Balance" }, { name: "Requires Admin" }],
    reviews: [review("DevUser", "APPROVED", "2026-10-18T14:00:00Z", 10)],
    labelEvents: [
      labelEvent("labeled", "Requires Admin", "Contributor", "2026-10-18T10:00:00Z", 1),
      reviewRequestedEvent({ team: "admin", requester: "label-sync-app[bot]", createdAt: "2026-10-18T10:00:05Z", id: 2 }),
      labelEvent("unlabeled", "Requires Admin", "Contributor", "2026-10-18T12:00:00Z", 3),
      labelEvent("labeled", "Requires Admin", "Contributor", "2026-10-18T13:00:00Z", 4),
      reviewRequestedEvent({ team: "balance-team", requester: "label-sync-app[bot]", createdAt: "2026-10-18T11:00:05Z", id: 5 }),
    ],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan.request.map((request) => request.reviewer.value), ["teams/admin", "teams/balance-team"]);
});

test("planReviewRequests skips pending reviewers, draft PRs, ignored authors and the PR author", async () => {
  const userEntry = [{ label: "Requires Admin", reviewer: { type: "user", login: "Contributor", value: "Contributor" }, when: "labeled", approvedBy: [] }];
  const base = {
    prLabels: [{ name: "Requires Admin" }],
    reviews: [],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  };

  const pending = await planReviewRequests({
    ...base,
    config: reviewRequestConfig(reviewRequestEntries),
    pendingReviewers: { users: [], teams: ["Admin"] },
  });
  const draft = await planReviewRequests({ ...base, config: reviewRequestConfig(reviewRequestEntries), isDraft: true });
  const ignored = await planReviewRequests({
    ...base,
    config: { ...reviewRequestConfig(reviewRequestEntries), ignoredPullRequestAuthors: ["contributor"] },
  });
  const author = await planReviewRequests({ ...base, config: reviewRequestConfig(userEntry) });

  for (const plan of [pending, draft, ignored, author]) {
    assert.deepEqual(plan, { request: [], withdraw: [] });
  }
});

test("planReviewRequests requests a reviewer shared by two present labels only once", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig([
      { label: "Requires Admin", reviewer: adminTeam, when: "labeled", approvedBy: [] },
      { label: "Security", reviewer: adminTeam, when: "labeled", approvedBy: [] },
    ]),
    prLabels: [{ name: "Requires Admin" }, { name: "Security" }],
    reviews: [],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.equal(plan.request.length, 1);
});

test("planReviewRequests withdraws a pending request that Label Sync made once the label is removed", async () => {
  const plan = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [],
    reviews: [],
    labelEvents: [
      labelEvent("labeled", "Requires Admin", "Contributor", "2026-10-18T10:00:00Z", 1),
      reviewRequestedEvent({ team: "admin", requester: "label-sync-app[bot]", createdAt: "2026-10-18T10:00:05Z", id: 2 }),
      labelEvent("unlabeled", "Requires Admin", "Contributor", "2026-10-18T11:00:00Z", 3),
    ],
    pendingReviewers: { users: [], teams: ["admin"] },
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
    isAutomationActor: isLabelSync,
  });

  assert.deepEqual(plan, { request: [], withdraw: [{ label: "Requires Admin", reviewer: adminTeam }] });
  assert.equal(
    formatReviewWithdrawal(plan.withdraw[0]),
    'Withdrew the review request for teams/admin because "Requires Admin" was removed.',
  );
});

test("planReviewRequests leaves requests made by people or still needed by another label", async () => {
  const humanRequest = await planReviewRequests({
    config: reviewRequestConfig(reviewRequestEntries),
    prLabels: [],
    reviews: [],
    labelEvents: [
      reviewRequestedEvent({ team: "admin", requester: "label-sync-app[bot]", createdAt: "2026-10-18T10:00:05Z", id: 1 }),
      reviewRequestedEvent({ team: "admin", requester: "SomeMaintainer", createdAt: "2026-10-18T10:30:00Z", id: 2 }),
    ],
    pendingReviewers: { users: [], teams: ["admin"] },
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
    isAutomationActor: isLabelSync,
  });
  assert.deepEqual(humanRequest.withdraw, []);

  const sharedReviewer = await planReviewRequests({
    config: reviewRequestConfig([
      { label: "Requires Admin", reviewer: adminTeam, when: "labeled", approvedBy: [] },
      { label: "Security", reviewer: adminTeam, when: "afterApproval", approvedBy: [] },
    ]),
    prLabels: [{ name: "Security" }],
    reviews: [],
    labelEvents: [
      reviewRequestedEvent({ team: "admin", requester: "label-sync-app[bot]", createdAt: "2026-10-18T10:00:05Z", id: 1 }),
    ],
    pendingReviewers: { users: [], teams: ["admin"] },
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
    isAutomationActor: isLabelSync,
  });
  assert.deepEqual(sharedReviewer, { request: [], withdraw: [] });
});

test("planReviewRequests does nothing when no review requests are configured", async () => {
  const plan = await planReviewRequests({
    config: emptyConfig,
    prLabels: [{ name: "Requires Admin" }],
    reviews: [],
    labelEvents: [],
    pullRequestAuthor: "Contributor",
    isTeamMember: isConfiguredTeamMember,
  });

  assert.deepEqual(plan, { request: [], withdraw: [] });
});
