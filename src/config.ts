import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PropertyValue } from "./properties.ts";

export type Config = {
  /** Systemd properties applied to every unit this tool starts. */
  properties: Record<string, PropertyValue>;
  /** Named property sets a call can pick with `preset`. */
  presets: Record<string, Record<string, PropertyValue>>;
};

const EMPTY: Config = { properties: {}, presets: {} };

export function configPath(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.PI_SYSTEMD_CONFIG;
  if (override?.startsWith("~/")) return join(homedir(), override.slice(2));
  if (override) return override;
  return join(agentDir, "extensions", "pi-systemd.json");
}

function values(input: unknown, label: string): Record<string, PropertyValue> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`"${label}" must be an object`);
  }
  const parsed: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parsed[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      parsed[key] = value;
      continue;
    }
    throw new Error(
      `"${label}.${key}" must be a string, number, boolean, or list of strings`,
    );
  }
  return parsed;
}

function validate(parsed: unknown): Config {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the file must contain a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  const presets: Record<string, Record<string, PropertyValue>> = {};
  if (object.presets !== undefined) {
    if (
      typeof object.presets !== "object" ||
      object.presets === null ||
      Array.isArray(object.presets)
    ) {
      throw new Error('"presets" must be an object');
    }
    for (const [name, value] of Object.entries(
      object.presets as Record<string, unknown>,
    )) {
      presets[name] = values(value, `presets.${name}`);
    }
  }
  return { properties: values(object.properties, "properties"), presets };
}

/** A missing file is not an error; a malformed one is reported without breaking the tool. */
export function loadConfig(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { config: Config; path: string; error?: string } {
  const path = configPath(agentDir, env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { config: EMPTY, path };
  }
  try {
    return { config: validate(JSON.parse(raw) as unknown), path };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: EMPTY, path, error: `${path}: ${detail}` };
  }
}

export function mergeProperties(
  ...layers: Array<Record<string, PropertyValue> | undefined>
): Record<string, PropertyValue> {
  return Object.assign({}, ...layers.filter(Boolean));
}
