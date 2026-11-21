import {
  truncateToVisualLines,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

/** Collapsed output keeps a tail, like the bash tool's five-line preview. */
const PREVIEW_VISUAL_LINES = 5;

type RenderTheme = {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
};

type TimerState = {
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
};

type RenderContext = {
  lastComponent: Component | undefined;
  keyHint(keybinding: "app.tools.expand", description: string): string;
  args?: Record<string, unknown>;
  state?: TimerState;
  executionStarted?: boolean;
  durationMs?: number;
  invalidate?: () => void;
};

type RenderOptions = {
  expanded: boolean;
  isPartial: boolean;
};

type RenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

type CardState = {
  done?: boolean;
  state?: string;
  sub?: string;
  result?: string;
  exitCode?: number;
  failed?: boolean;
};

type CardUnit = {
  unit?: string;
  active?: string;
  sub?: string;
  state?: string;
  command?: string;
};

type CardDetails = {
  unit?: string;
  id?: string;
  output?: string[];
  meta?: string[];
  notes?: string[];
  omitted?: number;
  cancelled?: boolean;
  state?: CardState;
  units?: CardUnit[];
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return strings.length === value.length ? strings : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function detailsOf(value: unknown): CardDetails | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const units = Array.isArray(record.units)
    ? record.units
        .map((entry) => recordOf(entry))
        .filter(
          (entry): entry is Record<string, unknown> => entry !== undefined,
        )
        .map((entry) => ({
          unit: stringField(entry.unit),
          active: stringField(entry.active),
          sub: stringField(entry.sub),
          state: stringField(entry.state),
          command: stringField(entry.command),
        }))
    : undefined;
  const state = recordOf(record.state);
  return {
    unit: stringField(record.unit),
    id: stringField(record.id),
    output: stringList(record.output),
    meta: stringList(record.meta),
    notes: stringList(record.notes),
    omitted: numberField(record.omitted),
    cancelled: record.cancelled === true,
    state: state
      ? {
          done: state.done === true,
          state: stringField(state.state),
          sub: stringField(state.sub),
          result: stringField(state.result),
          exitCode: numberField(state.exitCode),
          failed: state.failed === true,
        }
      : undefined,
    units,
  };
}

function oneLine(value: unknown, limit = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function textOf(result: RenderResult): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && part.text) parts.push(part.text);
  }
  return parts.join("\n");
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function startClock(context: RenderContext): void {
  const state = context.state;
  if (!state || !context.executionStarted) return;
  if (state.startedAt === undefined) state.startedAt = Date.now();
}

/** Live elapsed time while a result is partial; the tool's own duration once it settles. */
function clockText(
  context: RenderContext,
  options: RenderOptions,
): string | undefined {
  const state = context.state;

  if (options.isPartial) {
    if (!state || state.startedAt === undefined) return undefined;
    if (!state.interval) {
      state.interval = setInterval(() => context.invalidate?.(), 1000);
    }
    return `Elapsed ${formatDuration(Date.now() - state.startedAt)}`;
  }

  if (state?.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  const duration = context.durationMs;
  if (duration === undefined || duration < 1000) return undefined;
  // A start's duration is the D-Bus call plus the settle wait, not the unit's runtime.
  const action = context.args?.action;
  if (action !== "output" && action !== "stop") return undefined;
  return `Took ${formatDuration(duration)}`;
}

function formatState(state: CardState, done: boolean): string {
  const parts = [state.state ?? "unknown"];
  if (state.sub) parts[0] = `${parts[0]}/${state.sub}`;
  if (state.result && state.result !== "success")
    parts.push(`result=${state.result}`);
  if (typeof state.exitCode === "number" && done)
    parts.push(`exit=${state.exitCode}`);
  return parts.join(" ");
}

type Status = { marker: string; color: ThemeColor; label: string };

function statusOf(
  state: CardState | undefined,
  cancelled: boolean,
): Status | undefined {
  if (cancelled) return { marker: "■", color: "warning", label: "cancelled" };
  if (!state) return undefined;
  if (
    state.failed ||
    (state.done && typeof state.exitCode === "number" && state.exitCode !== 0)
  ) {
    return { marker: "✗", color: "error", label: formatState(state, true) };
  }
  if (state.done) {
    return { marker: "✓", color: "success", label: formatState(state, true) };
  }
  return { marker: "●", color: "accent", label: formatState(state, false) };
}

function headerText(
  details: CardDetails,
  theme: RenderTheme,
): string | undefined {
  const unit =
    details.unit ?? (details.id ? `${details.id}.service` : undefined);
  if (!unit) return undefined;
  const status = statusOf(details.state, details.cancelled === true);
  if (!status) return undefined;
  const title = theme.fg("toolTitle", theme.bold(unit));
  return `${theme.fg(status.color, status.marker)} ${title}  ${theme.fg(
    status.color,
    status.label,
  )}`;
}

/** Old results carry no details: drop the status line when a header replaces it. */
function fallbackBody(
  text: string,
  details: CardDetails,
  header: string | undefined,
): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (!header) return lines;
  const unit =
    details.unit ?? (details.id ? `${details.id}.service` : undefined);
  return lines.filter((line, index) => {
    if (index === 0) return false;
    return !(unit && line.startsWith(`${unit}: `));
  });
}

function listCard(
  details: CardDetails,
  theme: RenderTheme,
): string[] | undefined {
  if (!details.units?.length) return undefined;
  return details.units.map((entry) => {
    const unit = entry.unit ?? "unknown";
    const active = entry.active ?? "unknown";
    const marker = active === "active" ? "●" : active === "failed" ? "✗" : "○";
    const color: ThemeColor =
      active === "active" ? "accent" : active === "failed" ? "error" : "muted";
    const state = entry.state ?? `${active}/${entry.sub ?? "unknown"}`;
    const command = entry.command
      ? `  ${theme.fg("muted", entry.command)}`
      : "";
    return `${theme.fg(color, marker)} ${theme.fg(
      "toolOutput",
      unit,
    )}  ${theme.fg("muted", state)}${command}`;
  });
}

function callText(args: Record<string, unknown>, theme: RenderTheme): string {
  const action = typeof args.action === "string" ? args.action : "";
  let text = theme.fg("toolTitle", theme.bold(`bg ${action}`));

  if (action === "start") {
    const command = oneLine(args.command);
    if (command) text += ` ${theme.fg("toolOutput", `$ ${command}`)}`;
    const name = oneLine(args.name, 40);
    if (name) text += theme.fg("muted", ` (${name})`);
    const preset = oneLine(args.preset, 40);
    if (preset) text += theme.fg("muted", ` (preset ${preset})`);
    return text;
  }

  const id = oneLine(args.id);
  if (id) text += ` ${theme.fg("accent", id)}`;
  if (action === "output" && args.follow === true) {
    text += theme.fg("muted", " (following)");
  }
  return text;
}

export function renderBgCall(
  args: Record<string, unknown>,
  theme: RenderTheme,
  context: RenderContext,
): Component {
  startClock(context);
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  text.setText(callText(args, theme));
  return text;
}

/** Caches its wrapped tail per width. */
class TailPreview implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly text: string,
    private readonly hint: (hidden: number) => string,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const preview = truncateToVisualLines(
      this.text,
      PREVIEW_VISUAL_LINES,
      width,
      0,
      "end",
    );
    this.cachedLines = preview.skippedCount
      ? [
          truncateToWidth(this.hint(preview.skippedCount), width, "..."),
          ...preview.visualLines,
        ]
      : preview.visualLines;
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export function renderBgResult(
  result: RenderResult,
  options: RenderOptions,
  theme: RenderTheme,
  context: RenderContext,
): Component {
  const component =
    context.lastComponent instanceof Container
      ? context.lastComponent
      : new Container();
  component.clear();

  const details = detailsOf(result.details) ?? {};
  const text = textOf(result).trimEnd();
  const timer = clockText(context, options);

  const units = listCard(details, theme);
  if (units) {
    component.addChild(new Text(units.join("\n"), 0, 0));
    return component;
  }

  const header = headerText(details, theme);
  if (!header && !text) return component;

  const structured = header !== undefined;
  const meta = structured ? (details.meta ?? []) : [];
  const notes = structured ? (details.notes ?? []) : [];
  const body = structured
    ? (details.output ??
      (details.meta !== undefined ? [] : fallbackBody(text, details, header)))
    : text.split("\n");

  if (header) component.addChild(new Text(header, 0, 0));
  if (meta.length) {
    component.addChild(
      new Text(meta.map((line) => theme.fg("muted", line)).join("\n"), 0, 0),
    );
  }
  if (notes.length) {
    component.addChild(
      new Text(notes.map((line) => theme.fg("warning", line)).join("\n"), 0, 0),
    );
  }

  const styled = body.map((line) => theme.fg("toolOutput", line)).join("\n");

  if (options.expanded) {
    if (styled) component.addChild(new Text(`\n${styled}`, 0, 0));
  } else if (styled) {
    component.addChild(new Spacer(1));
    component.addChild(
      new TailPreview(
        styled,
        (hidden) =>
          `${theme.fg("muted", `... (${hidden} earlier lines, `)}${context.keyHint(
            "app.tools.expand",
            "to expand",
          )}${theme.fg("muted", ")")}`,
      ),
    );
  }

  if (details.omitted) {
    component.addChild(
      new Text(
        `\n${theme.fg("muted", `… ${details.omitted} earlier lines omitted`)}`,
        0,
        0,
      ),
    );
  }

  if (timer) {
    component.addChild(new Text(`\n${theme.fg("muted", timer)}`, 0, 0));
  }

  component.invalidate();
  return component;
}
