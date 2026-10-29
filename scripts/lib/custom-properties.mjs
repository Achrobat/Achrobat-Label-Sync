import { normalizeName, normalizeRepositoryRef } from "./config-utils.mjs";

// Organization custom property values are not part of the org repository listing, so repository filters in
// "customProperty" mode read them from the custom properties API. Both endpoints need the organization
// "Custom properties" read permission on the Label Sync token.

const SELECT_VALUE_TYPES = new Set(["single_select", "multi_select"]);
const PAGE_SIZE = 100;

async function readCustomProperties(request, apiPath) {
  try {
    return await request("GET", apiPath);
  } catch (error) {
    throw new Error(
      `Could not read organization custom properties: ${error.message} `
      + 'When "filterMode" is "customProperty", the Label Sync token needs the organization "Custom properties" read permission.',
    );
  }
}

export async function getOrganizationCustomPropertySchema(request, orgName) {
  return readCustomProperties(request, `/orgs/${orgName}/properties/schema`);
}

export async function getOrganizationCustomPropertyValues(request, orgName) {
  const values = [];

  for (let page = 1; ; page += 1) {
    const batch = await readCustomProperties(
      request,
      `/orgs/${orgName}/properties/values?per_page=${PAGE_SIZE}&page=${page}`,
    );
    values.push(...batch);

    if (batch.length < PAGE_SIZE) {
      return values;
    }
  }
}

// A misspelled property or option would otherwise select nothing in a whitelist rule and everything in a
// blacklist rule, so rules must name properties and options that exist in the organization.
export function assertCustomPropertyRulesMatchSchema(customProperties, schema, { configPath, configKey }) {
  const definitions = new Map(schema.map((definition) => [normalizeName(definition.property_name), definition]));

  for (const rule of customProperties.rules) {
    const definition = definitions.get(normalizeName(rule.property));

    if (!definition) {
      const available = schema.map((entry) => entry.property_name).join(", ") || "none";
      throw new Error(
        `${configPath} "${configKey}.rules" property "${rule.property}" is not an organization custom property. Available properties: ${available}.`,
      );
    }

    let allowedValues = null;

    if (SELECT_VALUE_TYPES.has(definition.value_type) && Array.isArray(definition.allowed_values)) {
      allowedValues = definition.allowed_values;
    } else if (definition.value_type === "true_false") {
      allowedValues = ["true", "false"];
    }

    if (!allowedValues) {
      continue;
    }

    const allowedKeys = new Set(allowedValues.map((value) => normalizeName(String(value))));

    for (const option of rule.options) {
      if (!allowedKeys.has(normalizeName(option))) {
        throw new Error(
          `${configPath} "${configKey}.rules" property "${definition.property_name}" has no option "${option}". Allowed options: ${allowedValues.join(", ")}.`,
        );
      }
    }
  }
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

// Returns copies of the repositories with custom_properties set to { "Property Name": value }. Properties a
// repository has not set fall back to the organization default value when one exists.
export function attachCustomPropertyValues(repositories, values, schema, orgName = "") {
  const valuesByRepository = new Map();

  for (const entry of values) {
    if (!entry?.repository_full_name) {
      continue;
    }

    const properties = {};

    for (const property of entry.properties ?? []) {
      properties[property.property_name] = property.value;
    }

    valuesByRepository.set(normalizeRepositoryRef(entry.repository_full_name), properties);
  }

  const defaults = schema.filter((definition) => hasValue(definition.default_value));

  return repositories.map((repository) => {
    const fullName = repository.full_name ?? `${repository.owner?.login ?? orgName}/${repository.name}`;
    const explicitValues = valuesByRepository.get(normalizeRepositoryRef(fullName)) ?? {};
    const customProperties = {};

    for (const definition of defaults) {
      customProperties[definition.property_name] = definition.default_value;
    }

    for (const [name, value] of Object.entries(explicitValues)) {
      if (hasValue(value)) {
        customProperties[name] = value;
      }
    }

    return { ...repository, custom_properties: customProperties };
  });
}

export async function loadRepositoryCustomProperties(
  repositories,
  { request, orgName, customProperties, configPath, configKey = "customProperties" },
) {
  const schema = await getOrganizationCustomPropertySchema(request, orgName);
  assertCustomPropertyRulesMatchSchema(customProperties, schema, { configPath, configKey });
  const values = await getOrganizationCustomPropertyValues(request, orgName);
  return attachCustomPropertyValues(repositories, values, schema, orgName);
}
