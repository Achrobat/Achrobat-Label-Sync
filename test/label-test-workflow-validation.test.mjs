import assert from "node:assert/strict";
import test from "node:test";

import { validateLabelTestWorkflowConfig } from "../scripts/lib/config-validation.mjs";

test("validateLabelTestWorkflowConfig accepts empty required labels", () => {
  const config = validateLabelTestWorkflowConfig({
    requiredLabels: [],
    failingLabels: ["Blocked"],
    protectedLabelApprovals: [
      { label: "Affects Balance", approver: "teams/admin" },
      { label: "Affects Balance", approver: "UltraProdigy" },
    ],
    workflowDistribution: {
      whitelist: ["example-repo", "example-org/other-repo"],
      blacklist: [],
    },
  });

  assert.deepEqual(config.requiredLabels, []);
  assert.deepEqual(config.failingLabels, ["Blocked"]);
  assert.deepEqual(config.protectedLabelApprovals, [
    { label: "Affects Balance", approver: { type: "team", slug: "admin", value: "teams/admin" } },
    { label: "Affects Balance", approver: { type: "user", login: "UltraProdigy", value: "UltraProdigy" } },
  ]);
  assert.equal(config.workflowDistribution.whitelist.has("example-repo"), true);
  assert.equal(config.workflowDistribution.whitelist.has("example-org/other-repo"), true);
});

test("validateLabelTestWorkflowConfig rejects duplicate required labels", () => {
  assert.throws(
    () => validateLabelTestWorkflowConfig({
      requiredLabels: ["Bug", "bug"],
      failingLabels: [],
      protectedLabelApprovals: [],
      workflowDistribution: { whitelist: [], blacklist: [] },
    }),
    /Duplicate requiredLabels entry detected: "bug"\./,
  );
});

test("validateLabelTestWorkflowConfig rejects team approvers without a slug", () => {
  assert.throws(
    () => validateLabelTestWorkflowConfig({
      requiredLabels: [],
      failingLabels: [],
      protectedLabelApprovals: [
        { label: "Affects Balance", approver: "teams/" },
      ],
      workflowDistribution: { whitelist: [], blacklist: [] },
    }),
    /protectedLabelApprovals approver "teams\/" must include a team slug after "teams\/"\./,
  );
});

test("validateLabelTestWorkflowConfig rejects duplicate protected approvers for one label", () => {
  assert.throws(
    () => validateLabelTestWorkflowConfig({
      requiredLabels: [],
      failingLabels: [],
      protectedLabelApprovals: [
        { label: "Affects Balance", approver: "teams/admin" },
        { label: "affects balance", approver: "teams/admin" },
      ],
      workflowDistribution: { whitelist: [], blacklist: [] },
    }),
    /Duplicate protectedLabelApprovals entry detected: "affects balance" with approver "teams\/admin"\./,
  );
});

test("validateLabelTestWorkflowConfig rejects invalid distribution repository names", () => {
  assert.throws(
    () => validateLabelTestWorkflowConfig({
      requiredLabels: [],
      failingLabels: [],
      protectedLabelApprovals: [],
      workflowDistribution: { whitelist: ["bad repo"], blacklist: [] },
    }),
    /"workflowDistribution.whitelist" entry "bad repo" must be either "repo-name" or "owner\/repo-name"\./,
  );
});
