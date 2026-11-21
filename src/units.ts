export const UNIT_PREFIX = "pi-systemd-";
export const UNIT_ID_RE = /^pi-systemd-[a-z0-9_.-]{1,64}$/;
export const MAX_DESCRIPTION = 120;

export type UnitState = {
  /** ActiveState is active/activating/reloading. */
  active: boolean;
  /** The unit can no longer produce output. */
  done: boolean;
  state: string;
  sub: string;
  result?: string;
  exitCode?: number;
  failed: boolean;
};

export type RawUnitState = {
  ActiveState?: string;
  SubState?: string;
  Result?: string;
  ExecMainStatus?: number;
};

export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
}

export function newUnitId(name?: string): string {
  const suffix = Math.random().toString(16).slice(2, 6);
  const slug = name ? sanitizeSlug(name) : "";
  return slug ? `${UNIT_PREFIX}${slug}-${suffix}` : `${UNIT_PREFIX}${suffix}`;
}

/** Accepts an id with or without the `.service` suffix; undefined when it is not one of ours. */
export function normalizeUnitId(raw: string): string | undefined {
  const id = raw.trim().replace(/\.service$/, "");
  return UNIT_ID_RE.test(id) ? id : undefined;
}

export function unitName(id: string): string {
  return `${id}.service`;
}

export function describeCommand(command: string): string {
  const prefix = "pi-systemd: ";
  const oneLine = command.replace(/\s+/g, " ").trim();
  const room = MAX_DESCRIPTION - prefix.length;
  return `${prefix}${oneLine.length > room ? `${oneLine.slice(0, room - 1)}…` : oneLine}`;
}

export function buildExecStart(
  command: string,
  shell = "/bin/sh",
): [string, string[], boolean] {
  return [shell, [shell, "-c", command], false];
}

export function buildEnvironment(
  env?: Record<string, string>,
  base?: NodeJS.ProcessEnv,
): string[] {
  const merged = new Map<string, string>();
  for (const key of [
    "PATH",
    "HOME",
    "TERM",
    "DBUS_SESSION_BUS_ADDRESS",
    "SHELL",
  ]) {
    const value = base?.[key];
    if (value) merged.set(key, value);
  }
  for (const [key, value] of Object.entries(env ?? {})) merged.set(key, value);
  return [...merged].map(([key, value]) => `${key}=${value}`);
}

export function mapUnitState(raw: RawUnitState): UnitState {
  const state = raw.ActiveState ?? "unknown";
  const sub = raw.SubState ?? "unknown";
  const active =
    state === "active" || state === "activating" || state === "reloading";
  return {
    active,
    done: !active,
    state,
    sub,
    result: raw.Result,
    exitCode: raw.ExecMainStatus,
    failed: state === "failed",
  };
}

export function formatState(state: UnitState): string {
  const parts = [`${state.state}/${state.sub}`];
  if (state.result && state.result !== "success")
    parts.push(`result=${state.result}`);
  if (typeof state.exitCode === "number" && !state.active)
    parts.push(`exit=${state.exitCode}`);
  return parts.join(" ");
}
