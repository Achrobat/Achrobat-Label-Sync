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

### Step 5: Generate and copy the token

    Be aware that GitHub only lets you do this one time. You will need to generate a new token if you lose it.

### Step 6: Store it as a repository secret

    In the forked Label-Sync repo, go to:

    Settings → Secrets and Variables → Actions → New Repository Secret

    Title the secret "LABEL_SYNC_TOKEN" unless you changed tokenSecretName in the properties config, then use that instead.

    Paste the P.A.T. key and add secret. You are now finished.

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

### Step 3: Set repository permissions

    GitHub Apps start with no permissions, so you must explicitly grant the permissions Label-Sync needs.

    For full functionality you will need precisely these repository permissions:

    - Metadata: Read Only
    - Issues: Read and Write
    - Pull Requests: Read and Write
    - Contents: Read and Write

### Step 4: Create the app

    Click Create GitHub App.

    After creating it, GitHub will take you to the app settings page.

    Find and copy the App ID. This is not the Client ID.

### Step 5: Generate a private key

    In the GitHub App settings page, go to:

    Private keys → Generate a private key

    GitHub will download a .pem file.

    Open the .pem file in a text editor and copy the entire contents, including:

    -----BEGIN RSA PRIVATE KEY-----

    and

    -----END RSA PRIVATE KEY-----

    Keep this key private. Do not commit it to your repository.

### Step 6: Install the app

    In the GitHub App settings page, go to:

    Install App

    Choose the user or organization where Label-Sync should run.

    For Label-Sync specifically, it is most ideal if you select All Repositories.

    There is an in-built filter in the configs so you won't accidentally touch repositories you want to avoid.

    But if you want to be extra sure, you can restrict access here.

### Step 7: Find the installation ID

    After installing the app, open the app installation settings page.

    The URL should look something like this:

    https://github.com/organizations/YOUR_ORG/settings/installations/12345678

    The number at the end of that URL is the installation ID.

### Step 8: Store the app details as repository secrets

    In the forked Label-Sync repo, go to:

    Settings → Secrets and Variables → Actions → New Repository Secret

    Create the following three secrets:

    - LABEL_SYNC_APP_ID
    - LABEL_SYNC_APP_PRIVATE_KEY
    - LABEL_SYNC_APP_INSTALLATION_ID

    For LABEL_SYNC_APP_ID:

    Paste the GitHub App ID from the app settings page.

    For LABEL_SYNC_APP_PRIVATE_KEY:

    Paste the full private key from the .pem file.

    For LABEL_SYNC_APP_INSTALLATION_ID:

    Paste the installation ID from the app installation URL.

    These names should be used unless you changed the following values in the properties config:

    - appIdSecretName
    - privateKeySecretName
    - installationIdSecretName

### Step 9: Finish configuration

    Make sure your Label-Sync config is set to use GitHub App authentication instead of PAT authentication.

    Once the three secrets are added and the config is set to GitHub App mode, you are finished.