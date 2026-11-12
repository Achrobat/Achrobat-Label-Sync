import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, readJsonc } from "./lib/config-utils.mjs";
import { validateProperties } from "./lib/config-validation.mjs";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "label-sync-auth",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function outputToken(token, tokenPermissions = null, tokenLogin = null) {
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
      `LABEL_SYNC_TOKEN_PERMISSIONS=${tokenPermissions ? JSON.stringify(tokenPermissions) : ""}`,
      `LABEL_SYNC_TOKEN_LOGIN=${tokenLogin ?? ""}`,
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

// Installation tokens act as "<app-slug>[bot]", but they cannot look up their own app. The slug is
// read here with the app JWT so Label Test can recognize label changes made by Label Sync workflows
// such as Remove-Labels. This lookup is best effort and never blocks token creation.
async function getAppBotLogin(jwt) {
  try {
    const response = await fetch("https://api.github.com/app", {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
    });

    if (!response.ok) {
      return null;
    }

    const app = await response.json();
    return typeof app?.slug === "string" && app.slug ? `${app.slug}[bot]` : null;
  } catch {
    return null;
  }
}

// Without an installation ID, the installation is looked up from the organization in config, so the
// private key is the only secret a copy needs.
export async function getOrganizationInstallationId(jwt, organization, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(organization)}/installation`, {
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`The GitHub App is not installed on ${organization} (${response.status}): ${message}`);
  }

  const installation = await response.json();
  assert(installation?.id, `The installation lookup for ${organization} did not return an ID.`);
  return String(installation.id);
}

async function createInstallationToken({ appId, privateKey, installationId, organization }) {
  const jwt = createAppJwt(appId, privateKey);
  const resolvedInstallationId = installationId || await getOrganizationInstallationId(jwt, organization);
  const response = await fetch(`https://api.github.com/app/installations/${resolvedInstallationId}/access_tokens`, {
    method: "POST",
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${jwt}` },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub App installation token request failed with ${response.status}: ${message}`);
  }

  const body = await response.json();
  assert(body.token, "GitHub App installation token response did not include a token.");
  return {
    token: body.token,
    permissions: body.permissions ?? null,
    login: await getAppBotLogin(jwt),
  };
}

// Values passed in the environment (from secrets) win over config, so copies that still keep the App ID in a
// secret keep working.
export function resolveAppSettings(properties, env = process.env) {
  const configPath = "properties.authentication.githubApp";

  return {
    appId: env.GITHUB_APP_ID || env.LABEL_SYNC_GITHUB_APP_ID || properties.authentication?.githubApp?.appId || "",
    privateKey: env.GITHUB_APP_PRIVATE_KEY || env.LABEL_SYNC_GITHUB_APP_PRIVATE_KEY || "",
    installationId: env.GITHUB_APP_INSTALLATION_ID || env.LABEL_SYNC_GITHUB_APP_INSTALLATION_ID || "",
    organization: properties.organization,
    configPath,
  };
}

async function main() {
  const mode = process.env.AUTH_MODE ?? process.env.LABEL_SYNC_AUTH_MODE ?? "pat";

  if (mode === "pat") {
    // A secret that does not exist reaches the workflow as an empty string, so || is used to skip it. There is
    // deliberately no GITHUB_TOKEN fallback: Label Sync either has its configured token or does not run.
    const token = process.env.PAT_TOKEN || process.env.LABEL_SYNC_TOKEN || process.env.CONFIG_LABEL_SYNC_TOKEN;
    assert(
      token,
      "The PAT secret is missing or empty. Create the secret named in properties.authentication.pat.tokenSecretName "
        + "as an organization or repository secret that this workflow can read.",
    );
    await outputToken(token);
    return;
  }

  assert(mode === "githubApp", 'AUTH_MODE must be either "pat" or "githubApp".');

  const properties = validateProperties(await readJsonc(path.join(process.cwd(), "config", "properties.jsonc")), {
    requireOrganization: true,
  });
  const { appId, privateKey, installationId, organization, configPath } = resolveAppSettings(properties);

  assert(appId, `Set ${configPath}.appId to the GitHub App's ID.`);
  assert(privateKey, `The GitHub App private key is missing or empty. Create the secret named in ${configPath}.privateKeySecretName.`);

  const { token, permissions, login } = await createInstallationToken({ appId, privateKey, installationId, organization });
  await outputToken(token, permissions, login);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
