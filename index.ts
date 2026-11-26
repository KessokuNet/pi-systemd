import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { loadConfig, mergeProperties } from "./src/config.ts";
import { SystemdUserBus } from "./src/dbus.ts";
import {
  createJournalReader,
  type JournalReader,
  type JournalRecord,
} from "./src/journald.ts";
import {
  inferOutcome,
  renderOutput,
  selectRecords,
  terminalOutput,
} from "./src/output.ts";
import { resolveProperties, type PropertyValue } from "./src/properties.ts";
import { renderBgCall, renderBgResult } from "./src/render.ts";
import {
  buildEnvironment,
  buildExecStart,
  describeCommand,
  formatState,
  newUnitId,
  normalizeUnitId,
  unitName,
  type UnitState,
} from "./src/units.ts";

const ACTIONS = ["start", "output", "status", "stop", "list"] as const;
const DEFAULT_LINES = 200;
const DEFAULT_FOLLOW_SECONDS = 120;
const STATE_POLL_MS = 500;
const START_SETTLE_MS = 3000;
const UPDATE_THROTTLE_MS = 100;

export const GUIDANCE = `Long-running commands belong in systemd, not in bash.
- Use bg with action "start" for builds, test suites, servers, anything that outlives the time you want to wait. It creates a transient systemd user unit; the work keeps running even if this session ends or is interrupted.
- start ends the turn. When the unit finishes, this session is woken with its exit status and the tail of its journal, so do not poll: only call output when you want more of the log than the wake carried, or with follow: true when you deliberately want to watch a unit that is still running.
- Check with action "status", end with action "stop". Never kill these processes by PID or pattern; stop the unit.
- Sandboxing, resource limits, and Exec hooks go in start's properties (e.g. NoNewPrivileges, ProtectSystem, MemoryMax, TasksMax, ExecStartPre). Names ending in …Sec are converted to the …USec property systemd's D-Bus API expects. Shared defaults live in the pi-systemd config file under properties, and named sets under presets, picked with the preset parameter.`;

type ToolText = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type Tracked = {
  id: string;
  unit: string;
  command: string;
  cwd: string;
  startedAt: string;
  /** Sandboxing and resource properties this unit was asked to run with. */
  properties: Record<string, PropertyValue>;
};

function propertyInput(value: unknown): Record<string, PropertyValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const input: Record<string, PropertyValue> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      input[name] = entry;
    } else if (
      Array.isArray(entry) &&
      entry.every((item) => typeof item === "string")
    ) {
      input[name] = entry as string[];
    }
  }
  return input;
}

function propertyText(values: Record<string, unknown>): string | undefined {
  const entries = Object.entries(values);
  if (!entries.length) return undefined;
  return entries
    .map(
      ([name, value]) =>
        `${name}=${Array.isArray(value) ? value.join(",") : String(value)}`,
    )
    .join(" ");
}

function ok(text: string, details: Record<string, unknown> = {}): ToolText {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}): ToolText {
  return { content: [{ type: "text", text }], details, isError: true };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function statusLine(
  label: string,
  state: UnitState | undefined,
  records: JournalRecord[],
): string {
  if (state) return `${label}: ${formatState(state)}`;
  const outcome = inferOutcome(records);
  if (outcome) return `${label}: ${outcome} (unloaded by systemd)`;
  return records.length
    ? `${label}: finished (unloaded by systemd)`
    : `${label}: no such unit and no output found`;
}

function body(
  unit: string,
  state: UnitState | undefined,
  records: JournalRecord[],
  lines: string[],
  omitted: number,
): string {
  const parts = [statusLine(unit, state, records)];
  if (omitted) parts.push(`… ${omitted} earlier lines omitted`);
  parts.push(lines.length ? lines.join("\n") : "(no output)");
  return parts.join("\n");
}

/** systemd unloads a cleanly finished unit, so rebuild its state from the journal's verdict. */
function settledState(
  state: UnitState | undefined,
  records: JournalRecord[],
): UnitState | undefined {
  if (state) return state;
  const outcome = inferOutcome(records);
  if (outcome === "finished (exit 0)") {
    return {
      active: false,
      done: true,
      state: "inactive",
      sub: "dead",
      result: "success",
      exitCode: 0,
      failed: false,
    };
  }
  const failed = outcome ? /^failed \(result ([^)]+)\)$/.exec(outcome) : null;
  if (failed) {
    return {
      active: false,
      done: true,
      state: "failed",
      sub: "failed",
      result: failed[1],
      failed: true,
    };
  }
  // A clean finish can still be missing its lifecycle line when the journal lags the unload.
  if (records.length) {
    return {
      active: false,
      done: true,
      state: "inactive",
      sub: "dead",
      failed: false,
    };
  }
  return undefined;
}

export default function systemdBackground(pi: ExtensionAPI) {
  let busPromise: Promise<SystemdUserBus> | undefined;
  let readerPromise: Promise<JournalReader> | undefined;
  const tracked = new Map<string, Tracked>();

  const bus = (): Promise<SystemdUserBus> => {
    if (!busPromise) {
      busPromise = SystemdUserBus.connect().catch((error: unknown) => {
        busPromise = undefined;
        throw error;
      });
    }
    return busPromise;
  };

  const reader = (): Promise<JournalReader> => {
    if (!readerPromise) readerPromise = createJournalReader();
    return readerPromise;
  };

  const resolve = (raw: string): { id: string; unit: string } => {
    const id = normalizeUnitId(raw);
    if (!id) throw new Error(`"${raw}" is not a pi-systemd unit id`);
    return { id, unit: unitName(id) };
  };

  const stateOf = async (unit: string): Promise<UnitState | undefined> => {
    try {
      return await (await bus()).unitState(unit);
    } catch {
      return undefined;
    }
  };

  /** Units already woken for, so a restart of the waiter never double-fires. */
  const woken = new Set<string>();

  /**
   * Wake this session when a unit finishes, instead of leaving the caller to poll.
   * `systemctl --user wait` blocks until the unit is inactive; its exit tells us
   * when to look, and the unit's own state tells us how it went.
   */
  const wakeOnFinish = (unit: string, id: string, command: string): void => {
    if (woken.has(unit)) return;
    const child = spawn("systemctl", ["--user", "wait", unit], {
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.on("close", () => {
      woken.add(unit);
      void (async () => {
        const state = await stateOf(unit);
        const { records } = await (await reader()).read(unit);
        const { lines: tail } = renderOutput(
          selectRecords(records, false),
          20,
        );
        const exitCode = state?.exitCode ?? (state?.failed ? 1 : 0);
        const verdict = state?.failed ? "failed" : "finished";
        pi.sendMessage(
          {
            customType: "bg-finished",
            display: true,
            content: [
              `bg ${id} ${verdict}: exit ${exitCode}`,
              `$ ${command}`,
              ...tail,
            ].join("\n"),
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      })().catch(() => undefined);
    });
  };

  const waitForState = async (
    unit: string,
    what: "appears" | "stops",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<UnitState | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let state = await stateOf(unit);
    while (Date.now() < deadline && !signal?.aborted) {
      const settled =
        what === "appears" ? state !== undefined : state?.done === true;
      if (settled) return state;
      await sleep(STATE_POLL_MS, signal);
      state = await stateOf(unit);
    }
    return state;
  };

  const history = async (
    unit: string,
    lines: number,
    includeAll: boolean,
  ): Promise<{
    text: string;
    state: UnitState | undefined;
    output: string[];
    omitted: number;
  }> => {
    const state = await stateOf(unit);
    const { records } = await (await reader()).read(unit);
    const selected = selectRecords(records, includeAll);
    const { lines: rendered, omitted } = renderOutput(selected, lines);
    return {
      text: body(unit, state, records, rendered, omitted),
      state: settledState(state, records),
      output: terminalOutput(selected, lines),
      omitted,
    };
  };

  async function run(
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolText) => void) | undefined,
    ctx: ExtensionToolContext,
  ): Promise<ToolText> {
    const action = String(params.action);
    const lines =
      typeof params.lines === "number" ? params.lines : DEFAULT_LINES;
    const includeAll = params.all === true;

    if (action === "start") {
      if (typeof params.command !== "string" || !params.command.trim()) {
        return fail('action "start" needs a command.');
      }
      if (params.timeout !== undefined) {
        return fail(
          'timeout applies to action "output"; set a runtime limit with properties: { RuntimeMaxSec: N }',
        );
      }
      const command = params.command;
      const id = newUnitId(
        typeof params.name === "string" ? params.name : undefined,
      );
      const unit = unitName(id);
      const cwd = typeof params.cwd === "string" ? params.cwd : ctx.cwd;
      const environment = buildEnvironment(
        Object.fromEntries(
          Object.entries(
            (params.env as Record<string, string> | undefined) ?? {},
          ).map(([key, value]) => [key, String(value)]),
        ),
      );

      const {
        config,
        path: configFile,
        error: configError,
      } = loadConfig(getAgentDir());
      const preset =
        typeof params.preset === "string" ? params.preset : undefined;
      if (preset && !config.presets[preset]) {
        const available = Object.keys(config.presets);
        return fail(
          [
            `unknown preset "${preset}"`,
            available.length
              ? `available presets: ${available.join(", ")}`
              : `no presets are defined in ${configFile}`,
            configError,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const requested = mergeProperties(
        config.properties,
        preset ? config.presets[preset] : undefined,
        propertyInput(params.properties),
      );
      if ("ExecStart" in requested) {
        return fail(
          "pass the command through start's command parameter, not properties.ExecStart",
        );
      }
      const connection = await bus();
      const { resolved, inferred } = resolveProperties(
        requested,
        await connection.servicePropertyTypes(),
      );
      await connection.startTransientUnit({
        unit,
        description: describeCommand(command),
        execStart: buildExecStart(command),
        cwd,
        environment,
        properties: resolved,
      });
      const state = await waitForState(
        unit,
        "appears",
        START_SETTLE_MS,
        signal,
      );
      const applied = requested;
      tracked.set(id, {
        id,
        unit,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        properties: applied,
      });
      wakeOnFinish(unit, id, command);
      const { records } = await (await reader()).read(unit);
      const selected = selectRecords(records, includeAll);
      const { lines: rendered, omitted } = renderOutput(selected, lines);
      const settled = settledState(state, records);
      const properties = propertyText(applied);
      const notes = [
        inferred.length
          ? `not in systemd's introspection, sent as inferred types: ${inferred.join(", ")}`
          : undefined,
        configError ? `config ignored: ${configError}` : undefined,
      ].filter((note): note is string => note !== undefined);
      return ok(
        [
          `started ${unit} (cwd ${cwd})`,
          properties ? `properties: ${properties}` : undefined,
          ...notes,
          body(unit, state, records, rendered, omitted),
        ]
          .filter(Boolean)
          .join("\n"),
        {
          id,
          unit,
          command,
          cwd,
          properties: applied,
          state: settled,
          output: terminalOutput(selected, lines),
          omitted,
          meta: [
            cwd !== ctx.cwd ? `cwd ${cwd}` : undefined,
            properties ? `properties: ${properties}` : undefined,
          ].filter((line): line is string => line !== undefined),
          notes,
          exitCode: settled?.exitCode ?? (settled?.failed ? 1 : 0),
        },
      );
    }

    if (action === "list") {
      const listed = await (await bus()).listUnits("pi-systemd-");
      const units: Array<{
        unit: string;
        active: string;
        sub: string;
        state?: string;
        command?: string;
      }> = listed.map((entry) => ({
        unit: entry.unit,
        active: entry.active,
        sub: entry.sub,
        command: tracked.get(entry.unit.replace(/\.service$/, ""))?.command,
      }));
      const rows = units.map(
        (entry) =>
          `${entry.unit}  ${entry.active}/${entry.sub}${entry.command ? `  ${entry.command}` : ""}`,
      );
      for (const entry of tracked.values()) {
        if (!listed.some((item) => item.unit === entry.unit)) {
          rows.push(`${entry.unit}  unknown to systemd  ${entry.command}`);
          units.push({
            unit: entry.unit,
            active: "unknown",
            sub: "systemd",
            state: "unknown to systemd",
            command: entry.command,
          });
        }
      }
      return ok(rows.length ? rows.join("\n") : "no pi-systemd units", {
        count: rows.length,
        units,
      });
    }

    const raw = typeof params.id === "string" ? params.id : "";
    if (!raw)
      return fail(
        `action "${action}" needs an id (returned by action "start").`,
      );
    const { id, unit } = resolve(raw);

    if (action === "status") {
      const known = tracked.get(id);
      const state = await stateOf(unit);
      const { records } = await (await reader()).read(unit);
      const settled = settledState(state, records);
      const applied =
        known?.properties ?? (await (await bus()).notableProperties(unit));
      const meta = [
        known ? `command: ${known.command}` : undefined,
        known ? `cwd: ${known.cwd}` : undefined,
        known ? `started: ${known.startedAt}` : undefined,
        propertyText(applied)
          ? `properties: ${propertyText(applied)}`
          : undefined,
      ].filter((line): line is string => line !== undefined);
      const header = [statusLine(id, state, records), ...meta].join("\n");
      return ok(header, {
        id,
        unit,
        state: settled,
        properties: applied,
        meta,
      });
    }

    if (action === "stop") {
      await (await bus()).stopUnit(unit);
      await waitForState(unit, "stops", START_SETTLE_MS, signal);
      const { text, state, output, omitted } = await history(
        unit,
        lines,
        includeAll,
      );
      return ok(`stop requested\n${text}`, {
        id,
        unit,
        state,
        output,
        omitted,
        meta: [],
      });
    }

    if (action === "output") {
      const journal = await reader();
      const { records, cursor } = await journal.read(unit);
      const collected = selectRecords(records, includeAll);

      if (params.follow !== true) {
        const state = settledState(await stateOf(unit), records);
        const { lines: rendered, omitted } = renderOutput(collected, lines);
        return ok(body(unit, state, records, rendered, omitted), {
          id,
          unit,
          state,
          output: terminalOutput(collected, lines),
          omitted,
          meta: [],
          exitCode: state?.exitCode ?? (state?.failed ? 1 : 0),
        });
      }

      const seconds =
        typeof params.timeout === "number"
          ? params.timeout
          : DEFAULT_FOLLOW_SECONDS;
      const deadline = Date.now() + seconds * 1000;
      let state = await stateOf(unit);
      let done = state?.done ?? false;
      let known = state !== undefined || records.length > 0;
      const seen = records.slice();
      const seenLimit = Math.max(lines * 4, 1000);

      const snapshot = (): ToolText => {
        const selected = selectRecords(seen, includeAll);
        const { lines: rendered, omitted } = renderOutput(selected, lines);
        return ok(body(unit, state, seen, rendered, omitted), {
          id,
          unit,
          state,
          output: terminalOutput(selected, lines),
          omitted,
          meta: [],
          exitCode: state?.exitCode ?? (state?.failed ? 1 : 0),
        });
      };

      // Same cadence as the bash tool: one partial result per 100ms at most.
      let lastUpdateAt = 0;
      let pending: ToolText | undefined;
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      const flushUpdate = () => {
        updateTimer = undefined;
        if (!pending) return;
        const next = pending;
        pending = undefined;
        lastUpdateAt = Date.now();
        onUpdate?.(next);
      };
      const pushUpdate = (result: ToolText) => {
        if (!onUpdate) return;
        pending = result;
        const wait = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (wait <= 0) {
          if (updateTimer) clearTimeout(updateTimer);
          flushUpdate();
        } else if (!updateTimer) {
          updateTimer = setTimeout(flushUpdate, wait);
        }
      };
      const stopUpdates = () => {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = undefined;
        pending = undefined;
      };

      pushUpdate(snapshot());

      const tick = (fresh: JournalRecord[]) => {
        if (!fresh.length) return;
        seen.push(...fresh);
        if (seen.length > seenLimit) seen.splice(0, seen.length - seenLimit);
        pushUpdate(snapshot());
      };

      const poll = async () => {
        while (!done && !signal?.aborted && Date.now() < deadline) {
          await sleep(STATE_POLL_MS, signal);
          const next = await stateOf(unit);
          if (next) {
            state = next;
            known = true;
            if (next.done) {
              done = true;
              return;
            }
            continue;
          }
          // systemd only unloads a unit after it stopped, so a unit we have seen
          // before and that is now gone has finished; its verdict lives in the journal.
          if (known) {
            state = settledState(undefined, seen);
            done = true;
            return;
          }
          if (inferOutcome(seen)) {
            done = true;
            return;
          }
        }
        done = true;
      };

      const polling = poll();
      await journal.follow(unit, cursor, {
        onRecords: (fresh) => tick(fresh),
        isDone: () => done,
        signal,
        pollMs: 400,
      });
      await polling;
      stopUpdates();
      state = settledState(await stateOf(unit), seen);
      const cancelled = signal?.aborted === true && state?.done !== true;
      const selected = selectRecords(seen, includeAll);
      const { lines: rendered, omitted } = renderOutput(selected, lines);
      const trailing = cancelled
        ? "(cancelled; the unit keeps running)"
        : state?.done
          ? undefined
          : `(still running after ${seconds}s; call output with follow again to keep watching)`;
      const output = terminalOutput(selected, lines);
      return ok(
        [body(unit, state, seen, rendered, omitted), trailing]
          .filter(Boolean)
          .join("\n"),
        {
          id,
          unit,
          state,
          output: trailing ? [...output, trailing] : output,
          omitted,
          cancelled,
          meta: [],
          exitCode: state?.exitCode ?? (state?.failed ? 1 : 0),
        },
      );
    }

    return fail(`unknown action "${action}"`);
  }

  pi.registerTool({
    name: "bg",
    label: "Background unit",
    description: `Run and watch long commands as transient systemd user units, with output from the journal.
${GUIDANCE}
Actions:
- start: create a unit from a shell command (params: command, optional name, cwd, env, properties, preset).
- output: read the unit's output; follow: true keeps streaming until it exits (optional timeout, default ${DEFAULT_FOLLOW_SECONDS}s). Not needed to learn that a unit finished: start wakes this session with the exit status and the tail of the journal.
- status: state, command, cwd, start time, sandboxing properties.
- stop: ask systemd to stop the unit, then report its final output.
- list: units this tool has created.
The returned id is the systemd unit name without the .service suffix.`,
    promptSnippet:
      "Run a long command as a systemd user unit and read its journal output.",
    parameters: Type.Object({
      action: Type.Union(
        ACTIONS.map((value) => Type.Literal(value)),
        { description: "What to do with the unit." },
      ),
      command: Type.Optional(
        Type.String({
          description: 'Shell command to run; required for action "start".',
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            'Unit id from action "start"; required for output/status/stop.',
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: 'Short slug used in the unit name, e.g. "cargo-build".',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory; defaults to the session cwd.",
        }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Extra environment variables for the unit.",
        }),
      ),
      properties: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Union([
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Array(Type.String()),
          ]),
          {
            description:
              "For start: systemd unit properties, e.g. NoNewPrivileges, ProtectSystem, PrivateTmp, ReadOnlyPaths, MemoryMax, TasksMax, Nice, ExecStartPre. Values may be strings, numbers, booleans (yes/no also accepted), or lists of strings. An …Sec name maps to systemd's …USec D-Bus property. A properties.Environment replaces the inherited environment.",
          },
        ),
      ),
      preset: Type.Optional(
        Type.String({
          description:
            'For start: named property set from the pi-systemd config file (~/.pi/agent/extensions/pi-systemd.json, "presets" key).',
        }),
      ),
      timeout: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `For output: seconds to wait while following, default ${DEFAULT_FOLLOW_SECONDS}. For a runtime limit on start, use properties: { RuntimeMaxSec: N }.`,
        }),
      ),
      follow: Type.Optional(
        Type.Boolean({
          description: "For output: keep streaming until the unit exits.",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Include systemd lifecycle lines (Starting/Started/Stopped).",
        }),
      ),
      lines: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `How many trailing lines to show, default ${DEFAULT_LINES}.`,
        }),
      ),
    }),
    renderCall: renderBgCall,
    renderResult: renderBgResult,
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        return await run(params, signal, (result) => onUpdate?.(result), ctx);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.on("session_shutdown", () => {
    void busPromise
      ?.then((bus) => bus.disconnect())
      .catch(() => {
        // Nothing left to disconnect.
      });
  });
}
