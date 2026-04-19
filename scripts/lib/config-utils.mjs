import fs from "node:fs/promises";

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function normalizeColor(color) {
  return color.replace(/^#/, "").toLowerCase();
}

export function normalizeDescription(description) {
  return description ?? "";
}

export function normalizeName(name) {
  return name.trim().toLowerCase();
}

export function normalizeRepositoryRef(value) {
  return value.trim().toLowerCase();
}

function stripJsonComments(contents) {
  let result = "";
  let inString = false;
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < contents.length; index += 1) {
    const current = contents[index];
    const next = contents[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;

      if (isEscaped) {
        isEscaped = false;
      } else if (current === "\\") {
        isEscaped = true;
      } else if (current === "\"") {
        inString = false;
      }

      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === "\"") {
      inString = true;
    }

    result += current;
  }

  return result;
}

function extractLeadingHeader(contents) {
  const lines = contents.split(/\r?\n/);
  const headerLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      headerLines.push(line);
      continue;
    }

    break;
  }

  return headerLines.length > 0 ? `${headerLines.join("\n")}\n` : "";
}

export async function readJsonc(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(stripJsonComments(contents));
}

export async function writeJsoncPreservingHeader(filePath, value) {
  const existingContents = await fs.readFile(filePath, "utf8");
  const header = extractLeadingHeader(existingContents);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, `${header}${serialized}`, "utf8");
}
