import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  validateLabelTestWorkflowConfig,
  validateRepositoryFilter,
} from "../scripts/lib/config-validation.mjs";
import {
  activeFilterEntryCount,
  describeCustomPropertyRules,
  filterRepositories,
  formatFilterMode,
  repositoryPassesFilter,
} from "../scripts/lib/repository-selection.mjs";
import {
  assertCustomPropertyRulesMatchSchema,
  attachCustomPropertyValues,
  loadRepositoryCustomProperties,
} from "../scripts/lib/custom-properties.mjs";
import { selectDistributionRepositories } from "../scripts/distribute-label-test-workflows.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function repo(name, customProperties) {
  return { name, full_name: `example/${name}`, owner: { login: "example" }, custom_properties: customProperties };
}

function customPropertyFilter(logic, rules) {
  return validateRepositoryFilter({ filterMode: "customProperty", customProperties: { logic, rules } });
}

const schema = [
  { property_name: "Team", value_type: "single_select", allowed_values: ["Core", "Addons", "Tools"] },
  { property_name: "Platforms", value_type: "multi_select", allowed_values: ["Client", "Server"] },
  { property_name: "Deprecated", value_type: "true_false", default_value: "false" },
  { property_name: "Owner", value_type: "string" },
];

test("validateRepositoryFilter defaults filterMode to blacklist with no custom property rules", () => {
  const config = validateRepositoryFilter({});

  assert.equal(config.filterMode, "blacklist");
  assert.deepEqual(config.customProperties, { logic: "AND", rules: [] });
});

test("validateRepositoryFilter normalizes filterMode, logic, and rule modes", () => {
  const config = validateRepositoryFilter({
    filterMode: "CustomProperty",
    customProperties: {
      logic: "or",
      rules: [
        [" Team ", "WHITELIST", " Core ", "Addons"],
        ["Deprecated", "blacklist", "true"],
      ],
    },
  });

  assert.equal(config.filterMode, "customProperty");
  assert.deepEqual(config.customProperties, {
    logic: "OR",
    rules: [
      { property: "Team", mode: "whitelist", options: ["Core", "Addons"] },
      { property: "Deprecated", mode: "blacklist", options: ["true"] },
    ],
  });
});

test("validateRepositoryFilter rejects the replaced useWhitelist field", () => {
  assert.throws(
    () => validateRepositoryFilter({ useWhitelist: true }),
    /field "useWhitelist" was replaced by "filterMode"/,
  );
});

for (const [description, input, expected] of [
  ["an unknown filterMode", { filterMode: "allowlist" }, /field "filterMode" must be "whitelist", "blacklist", or "customProperty"\./],
  ["customProperty mode without rules", { filterMode: "customProperty" }, /"customProperties\.rules" must contain at least one rule when "filterMode" is "customProperty"\./],
  ["invalid logic", { customProperties: { logic: "XOR", rules: [] } }, /"customProperties\.logic" must be "AND" or "OR"\./],
  ["a rule without options", { customProperties: { rules: [["Team", "whitelist"]] } }, /"customProperties\.rules" entry at index 0 must be a list of non-empty strings/],
  ["a rule that is not a list", { customProperties: { rules: ["Team"] } }, /"customProperties\.rules" entry at index 0 must be a list/],
  ["an unknown rule mode", { customProperties: { rules: [["Team", "include", "Core"]] } }, /entry for "Team" must use "whitelist" or "blacklist" as its second value, not "include"\./],
  ["duplicate options", { customProperties: { rules: [["Team", "whitelist", "Core", "core"]] } }, /entry for "Team" lists option "core" more than once\./],
  ["duplicate property and mode", { customProperties: { rules: [["Team", "whitelist", "Core"], ["team", "whitelist", "Tools"]] } }, /Duplicate "customProperties\.rules" entry detected: "team" with whitelist\./],
]) {
  test(`validateRepositoryFilter rejects ${description}`, () => {
    assert.throws(() => validateRepositoryFilter(input), expected);
  });
}

test("validateLabelTestWorkflowConfig defaults workflowDistribution to whitelist mode", () => {
  const config = validateLabelTestWorkflowConfig({});

  assert.equal(config.workflowDistribution.filterMode, "whitelist");
  assert.deepEqual(config.workflowDistribution.customProperties, { logic: "AND", rules: [] });
});

test("validateLabelTestWorkflowConfig validates workflowDistribution custom property rules", () => {
  const config = validateLabelTestWorkflowConfig({
    workflowDistribution: {
      filterMode: "customProperty",
      customProperties: { logic: "AND", rules: [["Team", "whitelist", "Core"]] },
    },
  });

  assert.equal(config.workflowDistribution.filterMode, "customProperty");
  assert.equal(config.workflowDistribution.customProperties.rules.length, 1);

  assert.throws(
    () => validateLabelTestWorkflowConfig({ workflowDistribution: { filterMode: "customProperty" } }),
    /config\/label-test-workflow-config\.jsonc field "workflowDistribution\.customProperties\.rules" must contain at least one rule when "workflowDistribution\.filterMode" is "customProperty"\./,
  );
});

test("custom property AND logic requires every rule to pass", () => {
  const filter = customPropertyFilter("AND", [
    ["Team", "whitelist", "Core", "Addons"],
    ["Deprecated", "blacklist", "true"],
  ]);

  assert.equal(repositoryPassesFilter(repo("a", { Team: "Core", Deprecated: "false" }), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("b", { Team: "addons" }), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("c", { Team: "Core", Deprecated: "true" }), "example", filter), false);
  assert.equal(repositoryPassesFilter(repo("d", { Team: "Tools" }), "example", filter), false);
  assert.equal(repositoryPassesFilter(repo("e", {}), "example", filter), false);
});

test("custom property OR logic requires at least one rule to pass", () => {
  const filter = customPropertyFilter("OR", [
    ["Team", "whitelist", "Core"],
    ["Platforms", "whitelist", "Server"],
  ]);

  assert.equal(repositoryPassesFilter(repo("a", { Team: "Core" }), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("b", { Platforms: ["Client", "Server"] }), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("c", { Team: "Tools", Platforms: ["Client"] }), "example", filter), false);
});

test("custom property blacklist rules pass repositories without a value", () => {
  const filter = customPropertyFilter("AND", [["team", "blacklist", "Tools"]]);

  assert.equal(repositoryPassesFilter(repo("a", {}), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("b", undefined), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("c", { Team: null }), "example", filter), true);
  assert.equal(repositoryPassesFilter(repo("d", { Team: "TOOLS" }), "example", filter), false);
});

test("filterRepositories applies custom property rules and still skips the source repository", () => {
  const filter = customPropertyFilter("AND", [["Team", "whitelist", "Core"]]);
  const selected = filterRepositories(
    [
      repo("label-sync", { Team: "Core" }),
      repo("zeta", { Team: "Core" }),
      repo("alpha", { Team: "Core" }),
      repo("beta", { Team: "Tools" }),
    ],
    "example",
    filter,
    "example/label-sync",
  );

  assert.deepEqual(selected.map((repository) => repository.full_name), ["example/alpha", "example/zeta"]);
});

test("selectDistributionRepositories applies custom property mode from the config", () => {
  const { workflowDistribution } = validateLabelTestWorkflowConfig({
    workflowDistribution: {
      filterMode: "customProperty",
      customProperties: { rules: [["Team", "whitelist", "Addons"]] },
    },
  });
  const selected = selectDistributionRepositories(
    [repo("alpha", { Team: "Addons" }), repo("beta", { Team: "Core" })],
    { orgName: "example", sourceRepository: "example/label-sync", workflowDistribution },
  );

  assert.deepEqual(selected.map((repository) => repository.full_name), ["example/alpha"]);
});

test("filter display helpers describe the active mode and rules", () => {
  const filter = customPropertyFilter("AND", [
    ["Team", "whitelist", "Core", "Addons"],
    ["Deprecated", "blacklist", "true"],
  ]);

  assert.equal(activeFilterEntryCount(filter), 2);
  assert.equal(formatFilterMode("customProperty"), "Custom Property");
  assert.equal(formatFilterMode("whitelist"), "Whitelist");
  assert.equal(formatFilterMode("custom"), "Custom");
  assert.equal(
    describeCustomPropertyRules(filter.customProperties),
    "Team is Core or Addons AND Deprecated is not true",
  );
});

test("assertCustomPropertyRulesMatchSchema rejects unknown properties and options", () => {
  const options = { configPath: "config/repository-filter.jsonc", configKey: "customProperties" };
  const check = (rules) => assertCustomPropertyRulesMatchSchema(
    customPropertyFilter("AND", rules).customProperties,
    schema,
    options,
  );

  check([["team", "whitelist", "core"], ["Owner", "whitelist", "anything"], ["Deprecated", "blacklist", "TRUE"]]);

  assert.throws(
    () => check([["Teams", "whitelist", "Core"]]),
    /property "Teams" is not an organization custom property\. Available properties: Team, Platforms, Deprecated, Owner\./,
  );
  assert.throws(
    () => check([["Team", "whitelist", "Kore"]]),
    /property "Team" has no option "Kore"\. Allowed options: Core, Addons, Tools\./,
  );
  assert.throws(
    () => check([["Deprecated", "whitelist", "yes"]]),
    /property "Deprecated" has no option "yes"\. Allowed options: true, false\./,
  );
});

test("attachCustomPropertyValues applies explicit values over organization defaults", () => {
  const [alpha, beta, gamma] = attachCustomPropertyValues(
    [repo("alpha"), repo("beta"), repo("gamma")],
    [
      { repository_full_name: "Example/Alpha", properties: [{ property_name: "Team", value: "Core" }, { property_name: "Deprecated", value: "true" }] },
      { repository_full_name: "example/beta", properties: [{ property_name: "Deprecated", value: null }] },
    ],
    schema,
    "example",
  );

  assert.deepEqual(alpha.custom_properties, { Deprecated: "true", Team: "Core" });
  assert.deepEqual(beta.custom_properties, { Deprecated: "false" });
  assert.deepEqual(gamma.custom_properties, { Deprecated: "false" });
});

test("loadRepositoryCustomProperties reads the schema and every page of values", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    repository_full_name: `example/filler-${index}`,
    properties: [],
  }));
  const request = async (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);

    if (apiPath.endsWith("/properties/schema")) {
      return schema;
    }

    return apiPath.endsWith("&page=1")
      ? firstPage
      : [{ repository_full_name: "example/alpha", properties: [{ property_name: "Team", value: "Core" }] }];
  };

  const [alpha] = await loadRepositoryCustomProperties([repo("alpha")], {
    request,
    orgName: "example",
    customProperties: customPropertyFilter("AND", [["Team", "whitelist", "Core"]]).customProperties,
    configPath: "config/repository-filter.jsonc",
  });

  assert.deepEqual(calls, [
    "GET /orgs/example/properties/schema",
    "GET /orgs/example/properties/values?per_page=100&page=1",
    "GET /orgs/example/properties/values?per_page=100&page=2",
  ]);
  assert.equal(alpha.custom_properties.Team, "Core");
});

test("loadRepositoryCustomProperties explains the permission needed when the API rejects the token", async () => {
  await assert.rejects(
    loadRepositoryCustomProperties([], {
      request: async () => {
        throw new Error("GET /orgs/example/properties/schema failed with 403: Resource not accessible by integration");
      },
      orgName: "example",
      customProperties: customPropertyFilter("AND", [["Team", "whitelist", "Core"]]).customProperties,
      configPath: "config/repository-filter.jsonc",
    }),
    /failed with 403.*the Label Sync token needs the organization "Custom properties" read permission\./,
  );
});

test("05 - Distribute-Label-Workflow no longer asks for a repository selection mode", async () => {
  const workflow = await fs.readFile(
    path.join(workspaceRoot, ".github", "workflows", "05-distribute-label-test-workflows.yml"),
    "utf8",
  );

  assert.doesNotMatch(workflow, /repository_selection_mode|REPOSITORY_SELECTION_MODE/);
});
