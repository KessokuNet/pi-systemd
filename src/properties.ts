export type PropertyValue = string | number | boolean | string[];

export type ResolvedProperty = {
  name: string;
  signature: string;
  value: unknown;
};

/** Exec properties take a command, and systemd's `a(sasb)` struct is what its own CLI sends. */
const EXEC_PROPERTIES = new Set([
  "ExecStartPre",
  "ExecStartPost",
  "ExecStop",
  "ExecStopPost",
  "ExecReload",
]);
const EXEC_SIGNATURE = "a(sasb)";

const TRUE_WORDS = new Set(["yes", "true", "on", "1"]);
const FALSE_WORDS = new Set(["no", "false", "off", "0"]);

const NUMERIC_SIGNATURES = new Set(["y", "n", "q", "i", "u", "x", "t", "d"]);

/** systemd's D-Bus API takes microseconds; accept the `…Sec` spelling people know from unit files. */
export function timeAlias(
  name: string,
  signatures: Map<string, string>,
): string | undefined {
  if (!name.endsWith("Sec")) return undefined;
  const candidate = `${name.slice(0, -3)}USec`;
  return signatures.has(candidate) ? candidate : undefined;
}

export function parseBoolean(value: PropertyValue, name: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  throw new Error(
    `${name} expects a boolean (yes/no), got ${JSON.stringify(value)}`,
  );
}

function parseNumber(value: PropertyValue, name: string): number {
  const number =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    throw new Error(`${name} expects a number, got ${JSON.stringify(value)}`);
  }
  return number;
}

function parseStrings(value: PropertyValue, name: string): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") return [value];
  throw new Error(
    `${name} expects a string or list of strings, got ${JSON.stringify(value)}`,
  );
}

function execCommands(
  value: PropertyValue,
  name: string,
  shell: string,
): Array<[string, string[], boolean]> {
  return parseStrings(value, name).map((command) => [
    shell,
    [shell, "-c", command],
    false,
  ]);
}

function convert(
  name: string,
  signature: string,
  value: PropertyValue,
  shell: string,
): unknown {
  switch (signature) {
    case "b":
      return parseBoolean(value, name);
    case "s":
      return typeof value === "string" ? value : String(value);
    case "as":
    case "aay":
      return parseStrings(value, name);
    case "t":
      return parseNumber(value, name);
    default:
      if (NUMERIC_SIGNATURES.has(signature)) return parseNumber(value, name);
      throw new Error(
        `${name} has the D-Bus type "${signature}", which this tool cannot build from a plain value`,
      );
  }
}

/** Infers a signature for properties systemd's introspection does not list. */
export function inferSignature(value: PropertyValue): string {
  if (typeof value === "boolean") return "b";
  if (typeof value === "number") return "t";
  if (Array.isArray(value)) return "as";
  return "s";
}

export type ResolveResult = {
  resolved: ResolvedProperty[];
  inferred: string[];
};

export function resolveProperties(
  input: Record<string, PropertyValue>,
  signatures: Map<string, string>,
  shell = "/bin/sh",
): ResolveResult {
  const resolved: ResolvedProperty[] = [];
  const inferred: string[] = [];

  for (const [rawName, value] of Object.entries(input)) {
    if (EXEC_PROPERTIES.has(rawName)) {
      // systemd accepts the historic a(sasb) struct for every Exec property, its own CLI included.
      resolved.push({
        name: rawName,
        signature: EXEC_SIGNATURE,
        value: execCommands(value, rawName, shell),
      });
      continue;
    }

    const alias = timeAlias(rawName, signatures);
    if (alias) {
      resolved.push({
        name: alias,
        signature: "t",
        value: Math.round(parseNumber(value, rawName) * 1_000_000),
      });
      continue;
    }

    const known = signatures.get(rawName);
    if (!known) {
      inferred.push(rawName);
      resolved.push({
        name: rawName,
        signature: inferSignature(value),
        value: value,
      });
      continue;
    }
    resolved.push({
      name: rawName,
      signature: known,
      value: convert(rawName, known, value, shell),
    });
  }

  return { resolved, inferred };
}

/** Suggest the closest property names for a typo, so a failed start is easy to fix. */
export function suggestProperties(
  name: string,
  signatures: Map<string, string>,
): string[] {
  const needle = name.toLowerCase();
  return [...signatures.keys()]
    .filter((candidate) => candidate.toLowerCase().includes(needle.slice(0, 4)))
    .slice(0, 5);
}
