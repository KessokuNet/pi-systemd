import type { KoffiFunc, LibraryHandle } from "koffi";
import { spawn } from "node:child_process";

const SYSTEMD_LIBRARY = "libsystemd.so.0";
const DEFAULT_PRIORITY = 6;
const CLI_PAGE_LIMIT = "5000";
/** Longest slice sd_journal_wait may block the host event loop for. */
const WAIT_SLICE_US = 25_000;

export type JournalRecord = {
  message: string;
  priority: number;
  /** The user manager wrote this line (lifecycle announcements), not the unit's own process. */
  managerLine: boolean;
};

export type JournalRead = { records: JournalRecord[]; cursor?: string };

export type FollowOptions = {
  onRecords: (records: JournalRecord[]) => void;
  /** Ends the follow loop once true. */
  isDone: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
  pollMs?: number;
};

export type FollowResult = { cursor?: string };

export interface JournalReader {
  readonly kind: "native" | "cli";
  read(unit: string, cursor?: string): Promise<JournalRead>;
  follow(
    unit: string,
    cursor: string | undefined,
    options: FollowOptions,
  ): Promise<FollowResult>;
  close(): void;
}

type NativeFn = KoffiFunc<(...args: unknown[]) => unknown>;

type NativeBindings = {
  open: NativeFn;
  close: NativeFn;
  addMatch: NativeFn;
  addDisjunction: NativeFn;
  seekHead: NativeFn;
  seekTail: NativeFn;
  seekCursor: NativeFn;
  next: NativeFn;
  getData: NativeFn;
  getCursor: NativeFn;
  wait: NativeFn;
};

function bind(library: LibraryHandle, signature: string): NativeFn {
  return library.func(signature) as unknown as NativeFn;
}

async function loadNativeBindings(): Promise<NativeBindings | undefined> {
  try {
    const { load } = await import("koffi");
    const library = load(SYSTEMD_LIBRARY);
    return {
      open: bind(library, "int sd_journal_open(_Out_ void **ret, int flags)"),
      close: bind(library, "void sd_journal_close(void *j)"),
      addMatch: bind(
        library,
        "int sd_journal_add_match(void *j, const char *data, size_t size)",
      ),
      addDisjunction: bind(library, "int sd_journal_add_disjunction(void *j)"),
      seekHead: bind(library, "int sd_journal_seek_head(void *j)"),
      seekTail: bind(library, "int sd_journal_seek_tail(void *j)"),
      seekCursor: bind(
        library,
        "int sd_journal_seek_cursor(void *j, const char *cursor)",
      ),
      next: bind(library, "int sd_journal_next(void *j)"),
      getData: bind(
        library,
        "int sd_journal_get_data(void *j, const char *field, _Out_ const void **data, _Out_ size_t *length)",
      ),
      getCursor: bind(
        library,
        "int sd_journal_get_cursor(void *j, _Out_ char **cursor)",
      ),
      wait: bind(
        library,
        "int sd_journal_wait(void *j, uint64_t timeout_usec)",
      ),
    };
  } catch {
    return undefined;
  }
}

type Decode = (pointer: unknown, type: string, length: number) => Uint8Array;

/** Reads the user journal straight from libsystemd; no journalctl process is spawned. */
class NativeJournalReader implements JournalReader {
  readonly kind = "native" as const;

  constructor(
    private readonly bindings: NativeBindings,
    private readonly decode: Decode,
  ) {}

  private decodeField(pointer: unknown, length: number): string | undefined {
    if (length <= 0) return undefined;
    return Buffer.from(this.decode(pointer, "uint8_t", length)).toString(
      "utf8",
    );
  }

  private open(unit: string): unknown {
    const handle: unknown[] = [null];
    if (this.bindings.open(handle, 0) !== 0 || !handle[0])
      throw new Error("sd_journal_open failed");
    const journal = handle[0];
    this.bindings.addMatch(journal, `_SYSTEMD_USER_UNIT=${unit}`, 0);
    this.bindings.addDisjunction(journal);
    this.bindings.addMatch(journal, `USER_UNIT=${unit}`, 0);
    return journal;
  }

  private field(journal: unknown, name: string): string | undefined {
    const data: unknown[] = [null];
    const length: unknown[] = [0];
    if (this.bindings.getData(journal, name, data, length) !== 0)
      return undefined;
    const raw = this.decodeField(data[0], Number(length[0]));
    if (raw === undefined) return undefined;
    return raw.startsWith(`${name}=`) ? raw.slice(name.length + 1) : raw;
  }

  private cursor(journal: unknown): string | undefined {
    const out: unknown[] = [null];
    if (this.bindings.getCursor(journal, out) !== 0) return undefined;
    return typeof out[0] === "string" ? out[0] : undefined;
  }

  private drain(
    journal: unknown,
    unit: string,
    skipCursor?: string,
  ): { records: JournalRecord[]; cursor?: string } {
    const records: JournalRecord[] = [];
    let cursor: string | undefined;
    while (Number(this.bindings.next(journal)) > 0) {
      const message = this.field(journal, "MESSAGE");
      const priority = Number.parseInt(
        this.field(journal, "PRIORITY") ?? "",
        10,
      );
      const current = this.cursor(journal);
      cursor = current ?? cursor;
      if (message === undefined || current === skipCursor) continue;
      records.push({
        message,
        priority: Number.isNaN(priority) ? DEFAULT_PRIORITY : priority,
        managerLine: this.field(journal, "_SYSTEMD_USER_UNIT") !== unit,
      });
    }
    return { records, cursor };
  }

  private positionAtStart(journal: unknown, cursor?: string): void {
    // sd_journal_seek_cursor lands on the cursor record itself; drain() advances past it.
    if (cursor && this.bindings.seekCursor(journal, cursor) === 0) return;
    this.bindings.seekHead(journal);
  }

  async read(unit: string, cursor?: string): Promise<JournalRead> {
    const journal = this.open(unit);
    try {
      this.positionAtStart(journal, cursor);
      return this.drain(journal, unit, cursor);
    } finally {
      this.bindings.close(journal);
    }
  }

  async follow(
    unit: string,
    cursor: string | undefined,
    options: FollowOptions,
  ): Promise<FollowResult> {
    const pollMs = options.pollMs ?? 400;
    const journal = this.open(unit);
    try {
      if (cursor && this.bindings.seekCursor(journal, cursor) !== 0)
        this.bindings.seekTail(journal);
      else if (!cursor) this.bindings.seekTail(journal);
      let latest = cursor;
      let skip = cursor;
      while (!options.signal?.aborted) {
        const { records, cursor: next } = this.drain(journal, unit, skip);
        skip = undefined;
        latest = next ?? latest;
        if (records.length) options.onRecords(records);
        if ((await options.isDone()) || options.signal?.aborted) break;
        // A short blocking wait wakes on new data; the sleep yields the event loop to the host.
        this.bindings.wait(journal, WAIT_SLICE_US);
        await sleep(Math.max(0, pollMs - WAIT_SLICE_US / 1000), options.signal);
      }
      return { cursor: latest };
    } finally {
      this.bindings.close(journal);
    }
  }

  close(): void {
    // Each read opens and closes its own journal handle, so there is nothing held open here.
  }
}

type JournalctlJson = {
  MESSAGE?: string | number[];
  PRIORITY?: string;
  USER_UNIT?: string;
  __CURSOR?: string;
};

function runJournalctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("journalctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || stdout.length > 0) resolve(stdout);
      else
        reject(new Error(`journalctl exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function parseJournalctlLine(line: string): JournalRecord | undefined {
  let entry: JournalctlJson;
  try {
    entry = JSON.parse(line) as JournalctlJson;
  } catch {
    return { message: line, priority: DEFAULT_PRIORITY, managerLine: false };
  }
  const message = Array.isArray(entry.MESSAGE)
    ? Buffer.from(entry.MESSAGE).toString("utf8")
    : entry.MESSAGE;
  if (message === undefined) return undefined;
  const priority = Number.parseInt(entry.PRIORITY ?? "", 10);
  return {
    message,
    priority: Number.isNaN(priority) ? DEFAULT_PRIORITY : priority,
    managerLine: typeof entry.USER_UNIT === "string",
  };
}

/** Fallback when libsystemd or koffi is unavailable: the journalctl CLI, still JSON, no shell involved. */
class CliJournalReader implements JournalReader {
  readonly kind = "cli" as const;

  private parse(output: string): JournalRead {
    const records: JournalRecord[] = [];
    let cursor: string | undefined;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const record = parseJournalctlLine(line);
      if (record) records.push(record);
      try {
        const entry = JSON.parse(line) as JournalctlJson;
        cursor = entry.__CURSOR ?? cursor;
      } catch {
        // A non-JSON line carries no cursor.
      }
    }
    return { records, cursor };
  }

  async read(unit: string, cursor?: string): Promise<JournalRead> {
    const args = [
      "--user",
      "-u",
      unit,
      "--no-pager",
      "-o",
      "json",
      "-n",
      CLI_PAGE_LIMIT,
    ];
    if (cursor) args.push(`--after-cursor=${cursor}`);
    return this.parse(await runJournalctl(args));
  }

  async follow(
    unit: string,
    cursor: string | undefined,
    options: FollowOptions,
  ): Promise<FollowResult> {
    const pollMs = options.pollMs ?? 500;
    let latest = cursor;
    while (!options.signal?.aborted) {
      const { records, cursor: next } = await this.read(unit, latest);
      latest = next ?? latest;
      if (records.length) options.onRecords(records);
      if ((await options.isDone()) || options.signal?.aborted) break;
      await sleep(pollMs, options.signal);
    }
    return { cursor: latest };
  }

  close(): void {
    // Every read is a short-lived journalctl process, so there is nothing to release.
  }
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

export async function createJournalReader(): Promise<JournalReader> {
  const bindings = await loadNativeBindings();
  if (bindings) {
    const { decode } = await import("koffi");
    return new NativeJournalReader(bindings, decode);
  }
  return new CliJournalReader();
}
