import assert from "node:assert/strict";
import test from "node:test";

import { validateRepositoryFilter } from "../scripts/lib/config-validation.mjs";

test("validateRepositoryFilter supplies automatic sync defaults", () => {
  const config = validateRepositoryFilter({
    whitelist: [],
    blacklist: [],
  });

  assert.deepEqual(config.automaticSync, {
    enabled: false,
    deleteMissing: false,
    deleteGithubDefaultLabels: true,
    labelReplacements: "",
  });
});

test("validateRepositoryFilter preserves explicit automatic sync settings", () => {
  const config = validateRepositoryFilter({
    useWhitelist: false,
    whitelist: [],
    blacklist: [],
    automaticSync: {
      enabled: true,
      deleteMissing: true,
      deleteGithubDefaultLabels: false,
      labelReplacements: "bug=Bug Fix, enhancement=Feature",
    },
  });

  assert.deepEqual(config.automaticSync, {
    enabled: true,
    deleteMissing: true,
    deleteGithubDefaultLabels: false,
    labelReplacements: "bug=Bug Fix, enhancement=Feature",
  });
});

test("validateRepositoryFilter rejects a non-object automaticSync value", () => {
  assert.throws(
    () => validateRepositoryFilter({
      whitelist: [],
      blacklist: [],
      automaticSync: true,
    }),
    /config\/repository-filter\.jsonc field "automaticSync" must be an object\./,
  );
});

for (const [field, value, expectedType] of [
  ["enabled", "true", "boolean"],
  ["deleteMissing", 1, "boolean"],
  ["deleteGithubDefaultLabels", null, "boolean"],
  ["labelReplacements", [], "string"],
]) {
  test(`validateRepositoryFilter rejects invalid automaticSync.${field}`, () => {
    assert.throws(
      () => validateRepositoryFilter({
        whitelist: [],
        blacklist: [],
        automaticSync: { [field]: value },
      }),
      new RegExp(`config/repository-filter\\.jsonc field "automaticSync\\.${field}" must be a ${expectedType}\\.`),
    );
  });
}

test("validateRepositoryFilter rejects malformed automatic label replacements", () => {
  assert.throws(
    () => validateRepositoryFilter({
      whitelist: [],
      blacklist: [],
      automaticSync: {
        labelReplacements: "bug",
      },
    }),
    /Invalid label replacement "bug"\. Use old=new\./,
  );
});
