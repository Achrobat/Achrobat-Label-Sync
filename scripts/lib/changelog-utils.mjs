import fs from "node:fs/promises";
import path from "node:path";

const fakeChangelogFileName = "fake-changelog.md";
const latestChangelogFileName = "latest-changelog.md";
const historyDirectoryName = "History";
const defaultChangelogTimeZone = "America/New_York";

function getChangelogTimeZone() {
  return process.env.CHANGELOG_TIME_ZONE || defaultChangelogTimeZone;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatUtcTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatDatePath(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: getChangelogTimeZone(),
    year: "numeric",
  }).formatToParts(date);
  const partValues = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${partValues.year}-${partValues.month}-${partValues.day}`;
}

function formatWorkflowRunLink(metadata) {
  if (!metadata.serverUrl || !metadata.repository || !metadata.runId) {
    return "Unavailable";
  }

  return `[${metadata.workflowName} #${metadata.runNumber ?? metadata.runId}](${metadata.serverUrl}/${metadata.repository}/actions/runs/${metadata.runId})`;
}

function renderList(items, renderItem) {
  if (items.length === 0) {
    return "";
  }

  return items.map((item) => `- ${renderItem(item)}`).join("\n");
}

function renderSummaryLine(line) {
  const separatorIndex = line.indexOf(":");

  if (separatorIndex === -1) {
    return `- ${line}`;
  }

  const label = line.slice(0, separatorIndex + 1);
  const value = line.slice(separatorIndex + 1);
  return `- **${label}**${value}`;
}

function parseGeneratedDate(content, fallbackDate) {
  const generatedOnMatch =
    content.match(/^- \*\*Generated On:\*\* (\d{4}-\d{2}-\d{2})\s*$/m)
    ?? content.match(/^Generated On: (\d{4}-\d{2}-\d{2})\s*$/m);
  if (generatedOnMatch) {
    return generatedOnMatch[1];
  }

  return content.match(/^- Generated: (\d{4}-\d{2}-\d{2})T/m)?.[1] ?? fallbackDate;
}

function parseGeneratedTimestamp(content) {
  return content.match(/^- Generated: ([^\n]+)$/m)?.[1]
    ?? content.match(/^- \*\*Generated On:\*\* ([^\n]+?)\s*$/m)?.[1]
    ?? content.match(/^Generated On: ([^\n]+?)\s*$/m)?.[1]
    ?? "";
}

function parseWorkflowName(content, fallbackFileName) {
  const titleMatch = content.match(/^# (.+?) Changelog$/m);
  return slugify(titleMatch?.[1] ?? path.basename(fallbackFileName, ".md"));
}

async function getNextHistorySequence(historyDir, datePath, workflowSlug) {
  let maxSequence = 0;

  try {
    const entries = await fs.readdir(historyDir);
    const sequencePattern = new RegExp(
      `^${escapeRegExp(datePath)}-(\\d+)-${escapeRegExp(workflowSlug)}\\.md$`,
    );

    for (const entry of entries) {
      const match = entry.match(sequencePattern);
      if (match) {
        maxSequence = Math.max(maxSequence, Number.parseInt(match[1], 10));
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return maxSequence + 1;
}

async function getAvailableHistoryPath(historyDir, datePath, workflowSlug) {
  let sequence = await getNextHistorySequence(historyDir, datePath, workflowSlug);

  while (true) {
    const sequenceText = String(sequence).padStart(3, "0");
    const historyPath = path.join(historyDir, `${datePath}-${sequenceText}-${workflowSlug}.md`);

    try {
      await fs.access(historyPath);
      sequence += 1;
    } catch (error) {
      if (error.code === "ENOENT") {
        return historyPath;
      }

      throw error;
    }
  }
}

async function archiveExistingChangelogs(changelogDir, fallbackDate) {
  const historyDir = path.join(changelogDir, historyDirectoryName);
  let entries;

  try {
    entries = await fs.readdir(changelogDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const changelogEntries = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== fakeChangelogFileName &&
      entry.name !== "README.md",
  );

  if (changelogEntries.length === 0) {
    return;
  }

  await fs.mkdir(historyDir, { recursive: true });

  const changelogs = [];

  for (const entry of changelogEntries) {
    const sourcePath = path.join(changelogDir, entry.name);
    const content = await fs.readFile(sourcePath, "utf8");
    changelogs.push({
      content,
      entryName: entry.name,
      generatedTimestamp: parseGeneratedTimestamp(content),
      sourcePath,
    });
  }

  changelogs.sort(
    (left, right) =>
      left.generatedTimestamp.localeCompare(right.generatedTimestamp) || left.entryName.localeCompare(right.entryName),
  );

  for (const changelog of changelogs) {
    const datePath = parseGeneratedDate(changelog.content, fallbackDate);
    const workflowSlug = parseWorkflowName(changelog.content, changelog.entryName);
    const historyPath = await getAvailableHistoryPath(historyDir, datePath, workflowSlug);

    await fs.rename(changelog.sourcePath, historyPath);
    console.log(`Archived changelog to ${path.relative(process.cwd(), historyPath)}`);
  }
}

export function getWorkflowMetadata(workflowName) {
  return {
    workflowName,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runNumber: process.env.GITHUB_RUN_NUMBER ?? "",
    actor: process.env.GITHUB_ACTOR ?? "",
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
  };
}

export async function writeChangelog({ workflowName, dryRun = false, introLines = [], summaryLines = null, sections }) {
  const changedSections = sections.filter((section) => section.hasChanges);

  if (changedSections.length === 0) {
    console.log("No repository changes detected; changelog was not written.");
    return null;
  }

  const now = new Date();
  const metadata = getWorkflowMetadata(workflowName);
  const timestamp = formatUtcTimestamp(now);
  const generatedDate = formatDatePath(now);
  const fileName = dryRun ? fakeChangelogFileName : latestChangelogFileName;
  const changelogDir = path.join(process.cwd(), "changelogs");
  const changelogPath = path.join(changelogDir, fileName);
  const workflowRun = formatWorkflowRunLink(metadata);
  const renderedSummaryLines = typeof summaryLines === "function"
    ? summaryLines({ generatedDate, metadata, workflowRun })
    : summaryLines;

  const lines = renderedSummaryLines ? [
    `# ${workflowName} Changelog`,
    "",
    ...renderedSummaryLines.filter((line) => line !== null).map(renderSummaryLine),
    "",
    "## Changed Repositories",
    "",
  ] : [
    `# ${workflowName} Changelog`,
    "",
    `- Generated: ${timestamp}`,
    `- Workflow run: ${workflowRun}`,
    metadata.actor ? `- Actor: ${metadata.actor}` : null,
    ...introLines.map((line) => `- ${line}`),
    "",
    "## Changed Repositories",
    "",
  ].filter((line) => line !== null);

  for (const section of changedSections) {
    lines.push(`### ${section.repository}`);
    lines.push("");
    lines.push(...section.lines);
    lines.push("");
  }

  await fs.mkdir(changelogDir, { recursive: true });
  if (!dryRun) {
    await archiveExistingChangelogs(changelogDir, formatDatePath(now));
  }

  await fs.writeFile(changelogPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Wrote changelog to ${path.relative(process.cwd(), changelogPath)}`);
  return changelogPath;
}

export function renderLabelSyncSection(result) {
  const lines = [];

  const replacements = renderList(result.labelReplacements, (entry) => {
    if (entry.mode === "renamed") {
      return `Renamed \`${entry.oldName}\` to \`${entry.newName}\``;
    }

    return `Replaced \`${entry.oldName}\` with \`${entry.newName}\` on ${entry.matchedIssues} issues and ${entry.matchedPullRequests} pull requests`;
  });
  if (replacements) {
    lines.push("Label replacements:");
    lines.push(replacements);
    lines.push("");
  }

  const created = renderList(
    result.createdLabels,
    (label) => `Created \`${label.name}\` (#${label.color})${label.description ? `: ${label.description}` : ""}`,
  );
  if (created) {
    lines.push("Created labels:");
    lines.push(created);
    lines.push("");
  }

  const updated = renderList(result.updatedLabels, (entry) => {
    const changes = [];

    if (entry.before.name !== entry.after.name) {
      changes.push(`name \`${entry.before.name}\` -> \`${entry.after.name}\``);
    }

    if (entry.before.color !== entry.after.color) {
      changes.push(`color #${entry.before.color} -> #${entry.after.color}`);
    }

    if (entry.before.description !== entry.after.description) {
      changes.push(`description \`${entry.before.description}\` -> \`${entry.after.description}\``);
    }

    return `Updated \`${entry.before.name}\`: ${changes.join(", ")}`;
  });
  if (updated) {
    lines.push("Updated labels:");
    lines.push(updated);
    lines.push("");
  }

  const deletedConfigured = renderList(
    result.deletedConfiguredLabels,
    (label) => `Deleted configured removed label \`${label.name}\``,
  );
  if (deletedConfigured) {
    lines.push("Deleted labels from deleted-labels config:");
    lines.push(deletedConfigured);
    lines.push("");
  }

  const deletedGithubDefaults = renderList(
    result.deletedGithubDefaultLabels,
    (label) => `Deleted GitHub default label \`${label.name}\``,
  );
  if (deletedGithubDefaults) {
    lines.push("Deleted GitHub default labels:");
    lines.push(deletedGithubDefaults);
    lines.push("");
  }

  const deletedMissing = renderList(
    result.deletedMissingLabels,
    (label) => `Deleted unmanaged label \`${label.name}\``,
  );
  if (deletedMissing) {
    lines.push("Deleted unmanaged labels:");
    lines.push(deletedMissing);
    lines.push("");
  }

  return {
    repository: result.repository,
    hasChanges: result.hasChanges,
    lines: lines.length > 0 ? lines.slice(0, -1) : [],
  };
}

export function renderRemoveLabelsSection(result) {
  const lines = [];

  const removedIssues = renderList(
    result.removedIssues,
    (item) => `Removed \`${item.label}\` from issue [#${item.number}](${item.url})`,
  );
  if (removedIssues) {
    lines.push("Issues:");
    lines.push(removedIssues);
    lines.push("");
  }

  const removedPullRequests = renderList(
    result.removedPullRequests,
    (item) => `Removed \`${item.label}\` from pull request [#${item.number}](${item.url})`,
  );
  if (removedPullRequests) {
    lines.push("Pull requests:");
    lines.push(removedPullRequests);
    lines.push("");
  }

  return {
    repository: result.repository,
    hasChanges: result.removedIssues.length > 0 || result.removedPullRequests.length > 0,
    lines: lines.length > 0 ? lines.slice(0, -1) : [],
  };
}
