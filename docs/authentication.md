# Authentication

Label Sync workflows authenticate with either a Personal Access Token or a GitHub App. Choose the mode in `config/properties.jsonc` under `authentication.mode`.

## Supported authentication methods:

- **Personal Access Token (PAT)**
- **GitHub App**

---

## Which should I use?

A **Personal Access Token**, or **PAT**, is the simplest way to authenticate Label Sync. It lets the tool act as your GitHub user and use your access to update labels. Recommended for personal use.

A **GitHub App** is the more robust way to authenticate Label Sync. It lets the tool act as its own app identity instead of acting as a personal GitHub user. Recommended for organizations.

---

### PAT Pros

- **Fastest setup**  
  A PAT only takes a few minutes to create and does not require setting up a separate GitHub App.

- **Easy to understand**  
  The token belongs to your GitHub account, so permissions are based on the repositories you already have access to.

- **Good for testing**  
  PATs are convenient when you are trying Label Sync for the first time or running it locally.

### PAT Cons

- **Tied to one user account**  
  Label Sync acts as the person who created the token. If that user leaves the organization or loses access, the sync can break.

- **Manual token maintenance**  
  PATs may expire, need rotation, or require manual replacement if revoked.

- **Audit logs are less clean**  
  Changes may appear as being performed by your user instead of a dedicated Label Sync app or bot identity.

- **Higher risk if configured poorly or leaked**  
  If a PAT is given too much access or exposed, it can potentially be used anywhere the token has permission until it is revoked.

---

### GitHub App Pros

- **Dedicated app identity**  
  Label changes can appear as coming from the app instead of from an individual user.

- **More controlled access**  
  The app can be installed only on the repositories it needs, instead of relying on a user’s full repository access.

- **Least-privilege permissions**  
  GitHub Apps start with no permissions, so you explicitly grant only the permissions required for label syncing.

- **Easier to maintain long-term**  
  The setup is less likely to break if a maintainer leaves the organization or changes roles.

### GitHub App Cons

- **More setup work**  
  You need to create the app, configure permissions, generate a private key, install the app, and provide the app details to Label Sync.

- **Requires app installation**  
  The app must be installed on the organization or repositories you want Label Sync to manage.

- **Can feel unnecessary for small personal use**  
  For one user syncing a few personal repositories, a PAT is usually simpler and may be enough.

---

## How to Setup a P.A.T.

### Step 1: Create a fine-grained token

    In your GitHub account, go to:

    Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token

    You can use a classic token instead, but it's recommended you use a fine-grain for best practice.

### Step 2: Choose the resource owner

    Select the user or organization that owns the repositories you want to sync.

    If the repositories are under an organization, select that organization as the resource owner.

### Step 3: Choose repository access

    For Label-Sync specifically, it's the most ideal if you select **All Repositories**. 

    There is an in-built filter in the configs so you won't accidentally touch repositories you want to avoid. 

    But if you want to be extra sure, you can restrict access here. 

### Step 4: Set permissions

    For full functionality you will need precisely these permissions:

    - Metadata: Read Only
    - Issues: Read and Write
    - Pull Requests: Read and Write
    - Contents: Read and Write

    If any repository filter uses "filterMode": "customProperty", also add this organization permission:

    - Custom properties: Read Only

### Step 5: Generate and copy the token

    Be aware that GitHub only lets you do this one time. You will need to generate a new token if you lose it.

### Step 6: Store it as a secret

    In the forked Label-Sync repo, go to:

    Settings → Secrets and Variables → Actions → New Repository Secret

    Title the secret "LABEL_SYNC_TOKEN" unless you changed tokenSecretName in the properties config, then use that instead.

    Paste the P.A.T. key and add secret.

    If you use Label Test, the workflows that 05 - Distribute-Label-Workflow installs
    run inside each target repository and read this secret there. In that case, store it as an organization
    secret instead:

    Organization Settings → Secrets and Variables → Actions → New Organization Secret

    Give it repository access to this repository and every repository Label Test is distributed to. On GitHub
    Free, organization secrets are not available to private repositories, so Label Test only works in public
    repositories there.

    You are now finished.

--- 

## How to Setup a GitHub App

### Step 1: Create a new GitHub App

    In your GitHub account or organization, go to:

    Settings → Developer settings → GitHub Apps → New GitHub App

    If you are setting this up for an organization, create the app under the organization if possible.

### Step 2: Fill out the basic app details

    Give the app a clear name, such as:

    Label Sync Bot

    For the homepage URL, you can use the Label-Sync repository URL:

    https://github.com/UltraProdigy/Label-Sync

    If you are not using webhooks, you can disable the webhook option.

### Step 3: Set permissions

    GitHub Apps start with no permissions, so you must explicitly grant the permissions Label-Sync needs.

    Repository permissions:

    - Metadata: Read Only
    - Issues: Read and Write
    - Pull Requests: Read and Write
    - Contents: Read and Write
    - Workflows: Read and Write (05 - Distribute-Label-Workflow writes the Label Test workflow files)

    Organization permissions:

    - Members: Read Only (team approvers, removers and reviewers in Label Test)
    - Custom properties: Read Only (only if a repository filter uses "filterMode": "customProperty")

    Leave the webhook off. Label Sync does not use one.

### Step 4: Create the app and note its App ID

    Click Create GitHub App. On the app settings page, copy the App ID (not the Client ID).

    The App ID is not a secret: it is in the App's public URL. It goes in config/properties.jsonc:

    "githubApp": {
      "appId": 123456,
      "privateKeySecretName": "LABEL_SYNC_APP_PRIVATE_KEY"
    }

### Step 5: Generate a private key

    In the GitHub App settings page, go to:

    Private keys → Generate a private key

    GitHub will download a .pem file. Keep it private and never commit it.

### Step 6: Install the app

    In the GitHub App settings page, go to Install App and choose the organization.

    Select All Repositories. The repository filter in config decides what Label Sync touches.

    There is no installation ID to copy: Label Sync looks the installation up from "organization" in
    config/properties.jsonc each run, so reinstalling the app never breaks it.

### Step 7: Store the private key

    In this repository, go to:

    Settings → Secrets and Variables → Actions → New Repository Secret

    Name it LABEL_SYNC_APP_PRIVATE_KEY (or whatever privateKeySecretName says) and paste the whole .pem file.
    If you use Label Test, make it an organization secret instead (below).

    That is the only secret. Set "mode": "githubApp" in config/properties.jsonc and you are finished.

    Copies set up before appId existed may still have appIdSecretName and installationIdSecretName in
    config. They keep working; replace them with appId and delete those two secrets when convenient.

---

## Label Test and the secret

Label Test runs inside every repository it is distributed to, and reads the same private key there. So the
secret has to be readable in those repositories too:

    Organization Settings → Secrets and Variables → Actions → New Organization Secret

    Name it LABEL_SYNC_APP_PRIVATE_KEY and choose "Selected repositories": this repository plus every
    repository Label Test is distributed to. On GitHub Free, organization secrets do not reach private
    repositories, so add the same value as a repository secret in each private one.

Anyone who can push a workflow to one of those repositories can read the key, so keep the App's permissions to
the list above. The check result and the rerun after a review use the workflow's own GITHUB_TOKEN, so the App
needs no Actions or Commit statuses access.

After upgrading from a version without the GITHUB_TOKEN rerun, run 05 - Distribute-Label-Workflow again
(Direct Commit), so every caller grants actions: write. Until then, callers in target repositories fail to start.
