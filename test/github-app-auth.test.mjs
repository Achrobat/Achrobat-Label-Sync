import test from "node:test";
import assert from "node:assert/strict";
import { validateProperties } from "../scripts/lib/config-validation.mjs";
import { getOrganizationInstallationId, resolveAppSettings } from "../scripts/create-github-auth-token.mjs";

function appProperties(authentication) {
  return validateProperties({ organization: "Example", authentication }, { requireOrganization: true, requireAuthentication: true });
}

test("a GitHub App needs only its ID in config and one private key secret", () => {
  const properties = appProperties({
    mode: "githubApp",
    githubApp: { appId: 12345, privateKeySecretName: "ORG_MANAGER_APP_PRIVATE_KEY" },
  });

  assert.equal(properties.authentication.githubApp.appId, "12345");
  assert.equal(properties.githubAppPrivateKeySecretName, "ORG_MANAGER_APP_PRIVATE_KEY");
});

test("App ID and installation ID secrets are rejected", () => {
  for (const key of ["appIdSecretName", "installationIdSecretName"]) {
    assert.throws(
      () => appProperties({ mode: "githubApp", githubApp: { appId: 1, privateKeySecretName: "KEY", [key]: "OLD_SECRET" } }),
      /no longer supported/,
    );
  }
});

test("githubApp mode rejects a missing App ID, a bad App ID, or a missing private key secret", () => {
  assert.throws(() => appProperties({ mode: "githubApp", githubApp: { privateKeySecretName: "KEY" } }), /appId is required/);
  assert.throws(() => appProperties({ mode: "githubApp", githubApp: { appId: "abc", privateKeySecretName: "KEY" } }), /positive number/);
  assert.throws(() => appProperties({ mode: "githubApp", githubApp: { appId: 1 } }), /privateKeySecretName/);
});

test("resolveAppSettings takes the App ID from config and the key from the environment", () => {
  const properties = appProperties({ mode: "githubApp", githubApp: { appId: 1, privateKeySecretName: "MAIN_KEY" } });

  assert.deepEqual(resolveAppSettings(properties, { GITHUB_APP_PRIVATE_KEY: "pem" }), {
    appId: "1",
    privateKey: "pem",
    organization: "Example",
    configPath: "properties.authentication.githubApp",
  });
  assert.equal(resolveAppSettings(properties, { GITHUB_APP_ID: "9" }).appId, "1");
});

test("the installation is looked up from the organization", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    return Response.json({ id: 4242 });
  };

  assert.equal(await getOrganizationInstallationId("jwt", "Example", fetchImpl), "4242");
  assert.deepEqual(calls, [{ url: "https://api.github.com/orgs/Example/installation", authorization: "Bearer jwt" }]);

  await assert.rejects(
    getOrganizationInstallationId("jwt", "Example", async () => new Response("Not Found", { status: 404 })),
    /not installed on Example \(404\)/,
  );
});
