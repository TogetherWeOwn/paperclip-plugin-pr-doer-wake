// Verbatim copy of the host's plugin config validation, for tests only (copied 2026-10-27).
// Sources: paperclip container /app/server/src/services/plugin-config-validator.ts (validateInstanceConfig) and
// /app/server/src/services/json-schema-secret-refs.ts (collectSecretRefPaths, parseSecretRefBindingObject).
/* eslint-disable */
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
type JsonSchema = Record<string, unknown>;
export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // Register the secret-ref format used by plugin manifests to mark fields that
  // hold a Paperclip secret UUID rather than a raw value. The format is a UI
  // hint only — UUID validation happens in the secrets handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(schema);
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export type SecretRefBindingObject = {
  secretId: string;
  version: "latest" | number;
};

/**
 * Parses the `{ type: "secret_ref", secretId, version? }` binding object that
 * secret pickers submit for `format: "secret-ref"` config fields. Returns null
 * for anything else (raw values, bare secret-id strings, malformed objects).
 */
export function parseSecretRefBindingObject(value: unknown): SecretRefBindingObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  if (typeof record.secretId !== "string" || !isUuidSecretRef(record.secretId.trim())) return null;
  const version = record.version;
  if (version === undefined || version === null || version === "latest") {
    return { secretId: record.secretId.trim(), version: "latest" };
  }
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { secretId: record.secretId.trim(), version };
  }
  return null;
}

export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        walk(branch as Record<string, unknown>, prefix);
      }
    }

    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== "object") return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== "object") continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (propertySchema.format === "secret-ref") {
        paths.add(path);
      }
      walk(propertySchema, path);
    }
  }

  walk(schema, "");
  return paths;
}

