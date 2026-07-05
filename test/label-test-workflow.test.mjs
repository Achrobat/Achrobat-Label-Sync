import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseLatestReviewStates,
  evaluatePrLabelTest,
} from "../scripts/lib/label-test-workflow.mjs";

const emptyConfig = {
  requiredLabels: [],
  failingLabels: [],
  protectedLabelApprovals: [],
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
