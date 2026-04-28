import crypto from "node:crypto";
import fs from "node:fs/promises";
import { assert } from "./lib/config-utils.mjs";

async function outputToken(token) {
  console.log("::add-mask::" + token);

  if (!process.env.GITHUB_ENV) {
    console.log("Resolved GitHub auth token.");
    return;
  }

  await fs.appendFile(
    process.env.GITHUB_ENV,
    [
      `LABEL_SYNC_TOKEN=${token}`,
      `CONFIG_LABEL_SYNC_TOKEN=${token}`,
      `PUSH_TOKEN=${token}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function normalizePrivateKey(privateKey) {
  return privateKey.replace(/\\n/g, "\n").trim();
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  });
  const unsignedToken = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedToken)
    .sign(normalizePrivateKey(privateKey))
    .toString("base64url");

  return `${unsignedToken}.${signature}`;
}

async function createInstallationToken({ appId, privateKey, installationId }) {
  const jwt = createAppJwt(appId, privateKey);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "label-sync-auth",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub App installation token request failed with ${response.status}: ${message}`);
  }

  const body = await response.json();
  assert(body.token, "GitHub App installation token response did not include a token.");
  return body.token;
}

async function main() {
  const mode = process.env.AUTH_MODE ?? process.env.LABEL_SYNC_AUTH_MODE ?? "pat";

  if (mode === "pat") {
    const token = process.env.PAT_TOKEN ?? process.env.LABEL_SYNC_TOKEN ?? process.env.CONFIG_LABEL_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
    assert(token, "PAT_TOKEN is required when properties.authentication.mode is \"pat\".");
    await outputToken(token);
    return;
  }

  assert(mode === "githubApp", 'AUTH_MODE must be either "pat" or "githubApp".');

  const appId = process.env.GITHUB_APP_ID ?? process.env.LABEL_SYNC_GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? process.env.LABEL_SYNC_GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID ?? process.env.LABEL_SYNC_GITHUB_APP_INSTALLATION_ID;

  assert(appId, "GITHUB_APP_ID is required when properties.authentication.mode is \"githubApp\".");
  assert(privateKey, "GITHUB_APP_PRIVATE_KEY is required when properties.authentication.mode is \"githubApp\".");
  assert(installationId, "GITHUB_APP_INSTALLATION_ID is required when properties.authentication.mode is \"githubApp\".");

  const token = await createInstallationToken({ appId, privateKey, installationId });
  await outputToken(token);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
