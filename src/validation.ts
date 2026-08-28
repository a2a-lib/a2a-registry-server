import type { AgentCard } from "@a2a-js/sdk";
import { RegistryError } from "./errors.js";
import type { AgentQuery, HealthCheckConfig, JsonObject, RegistrationInput } from "./types.js";

/** Regex pattern for valid identifier strings (alphanumeric, dot, underscore, colon, hyphen). */
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/** Ensure value is a non-null, non-array object. */
function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryError(400, "invalid_request", `${field} must be a JSON object`);
  }
  return value as JsonObject;
}

/** Ensure value is a non-empty trimmed string within maximum character length limit. */
function nonEmptyString(value: unknown, field: string, maximum = 2048): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new RegistryError(400, "invalid_request", `${field} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

/** Validate identifier strings against ID_PATTERN. */
function validateIdentifier(value: unknown, field: string): string {
  const id = nonEmptyString(value, field, 128);
  if (!ID_PATTERN.test(id)) {
    throw new RegistryError(400, "invalid_request", `${field} may contain letters, numbers, '.', '_', ':', and '-' only`);
  }
  return id;
}

/** Validate logical agent ID format. */
export function validateId(value: unknown): string {
  return validateIdentifier(value, "id");
}

/** Validate agent instance ID format. */
export function validateInstanceId(value: unknown): string {
  return validateIdentifier(value, "instanceId");
}

/** Validate endpoint string as a valid http or https URL. */
function validateEndpoint(value: unknown, field: string): string {
  const endpoint = nonEmptyString(value, field, 2048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new RegistryError(400, "invalid_request", `${field} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RegistryError(400, "invalid_request", `${field} must use http or https`);
  }
  return url.toString();
}

/**
 * Infer the primary HTTP endpoint URL from an Agent Card.
 * Prefers `supportedInterfaces[].url` if available, falling back to legacy top-level `url`.
 */
export function inferEndpoint(agentCard: JsonObject): string | undefined {
  if (Array.isArray(agentCard.supportedInterfaces)) {
    for (const entry of agentCard.supportedInterfaces) {
      if (entry && typeof entry === "object" && "url" in entry && typeof entry.url === "string") {
        return entry.url;
      }
    }
  }
  return typeof agentCard.url === "string" ? agentCard.url : undefined;
}

/**
 * Validate an A2A Agent Card object payload.
 * Checks essential fields while retaining unknown fields for forward compatibility.
 */
export function validateAgentCard(value: unknown): AgentCard {
  const card = object(value, "agentCard");
  nonEmptyString(card.name, "agentCard.name", 256);

  if (card.capabilities !== undefined) object(card.capabilities, "agentCard.capabilities");
  if (card.skills !== undefined && !Array.isArray(card.skills)) {
    throw new RegistryError(400, "invalid_request", "agentCard.skills must be an array");
  }
  if (card.supportedInterfaces !== undefined && !Array.isArray(card.supportedInterfaces)) {
    throw new RegistryError(400, "invalid_request", "agentCard.supportedInterfaces must be an array");
  }

  const inferred = inferEndpoint(card);
  if (inferred !== undefined) validateEndpoint(inferred, "agentCard endpoint");

  // Keep unknown fields intact so newer A2A Agent Card versions remain discoverable.
  return card as unknown as AgentCard;
}

/** Validate key-value metadata object constraints (at most 32 entries). */
function validateMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "metadata");
  const entries = Object.entries(input);
  if (entries.length > 32) {
    throw new RegistryError(400, "invalid_request", "metadata may contain at most 32 entries");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 64 || typeof item !== "string" || item.length > 512) {
      throw new RegistryError(400, "invalid_request", "metadata keys must be 1-64 characters and values must be strings up to 512 characters");
    }
    result[key] = item;
  }
  return result;
}

/** Validate an optional active health check configuration. */
function validateHealthCheck(value: unknown): HealthCheckConfig | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "healthCheck");
  const protocol = input.protocol === undefined ? "http" : nonEmptyString(input.protocol, "healthCheck.protocol", 16);
  if (protocol !== "http" && protocol !== "tcp") {
    throw new RegistryError(400, "invalid_request", "healthCheck.protocol must be http or tcp");
  }

  let path: string | undefined;
  if (input.path !== undefined) {
    path = nonEmptyString(input.path, "healthCheck.path", 2048);
    if (!path.startsWith("/") || path.includes("\\") || path.includes("..")) {
      throw new RegistryError(400, "invalid_request", "healthCheck.path must be an absolute URL path without '..'");
    }
  }

  const integerOption = (name: "intervalSeconds" | "timeoutSeconds", minimum: number, maximum: number): number | undefined => {
    if (input[name] === undefined) return undefined;
    const result = Number(input[name]);
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
      throw new RegistryError(400, "invalid_request", `healthCheck.${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return result;
  };
  const intervalSeconds = integerOption("intervalSeconds", 1, 3600);
  const timeoutSeconds = integerOption("timeoutSeconds", 1, 30);

  return {
    protocol,
    ...(path === undefined ? {} : { path }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

/** Parse and validate request body payload into a RegistrationInput structure. */
export function parseRegistration(value: unknown): RegistrationInput {
  const input = object(value, "request body");
  const agentCard = validateAgentCard(input.agentCard);
  const cardRecord = agentCard as unknown as JsonObject;
  const rawEndpoint = input.endpoint ?? inferEndpoint(cardRecord);
  if (rawEndpoint === undefined) {
    throw new RegistryError(400, "invalid_request", "endpoint is required when the Agent Card has no supportedInterfaces[].url or legacy url");
  }

  let ttlSeconds: number | undefined;
  if (input.ttlSeconds !== undefined) {
    ttlSeconds = Number(input.ttlSeconds);
  } else if (input.ttlMs !== undefined) {
    ttlSeconds = Math.ceil(Number(input.ttlMs) / 1000);
  }
  if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new RegistryError(400, "invalid_request", "ttlSeconds must be a positive integer");
  }

  return {
    id: validateId(input.id),
    ...(input.instanceId === undefined ? {} : { instanceId: validateInstanceId(input.instanceId) }),
    endpoint: validateEndpoint(rawEndpoint, "endpoint"),
    agentCard,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    ...(input.metadata === undefined ? {} : { metadata: validateMetadata(input.metadata) }),
    ...(input.healthCheck === undefined ? {} : { healthCheck: validateHealthCheck(input.healthCheck) }),
  };
}

/** Extract an optional string query parameter from URL search params. */
function optionalQuery(url: URL, name: string, maximum = 256): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > maximum) throw new RegistryError(400, "invalid_query", `${name} is too long`);
  return value;
}

/** Parse URL search query parameters into an AgentQuery filter object. */
export function parseAgentQuery(url: URL): AgentQuery {
  const rawLimit = url.searchParams.get("limit") ?? "100";
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RegistryError(400, "invalid_query", "limit must be an integer between 1 and 500");
  }
  return {
    limit,
    ...(optionalQuery(url, "skill") ? { skill: optionalQuery(url, "skill") } : {}),
    ...(optionalQuery(url, "tag") ? { tag: optionalQuery(url, "tag") } : {}),
    ...(optionalQuery(url, "capability") ? { capability: optionalQuery(url, "capability") } : {}),
    ...(optionalQuery(url, "protocolBinding") ? { protocolBinding: optionalQuery(url, "protocolBinding") } : {}),
    ...(optionalQuery(url, "name") ? { name: optionalQuery(url, "name") } : {}),
    ...(optionalQuery(url, "cursor", 1024) ? { cursor: optionalQuery(url, "cursor", 1024) } : {}),
  };
}
