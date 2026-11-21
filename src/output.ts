import type { JournalRecord } from "./journald.ts";

const LIFECYCLE =
  /^(Starting|Started|Stopping|Stopped|Reloading|Deactivated successfully|Finished|Consumed )/;

/** systemd's own start/stop bookkeeping is noise; its failure lines are not. */
export function isLifecycleNoise(record: JournalRecord): boolean {
  return record.managerLine && LIFECYCLE.test(record.message);
}

export function selectRecords(
  records: JournalRecord[],
  includeAll = false,
): JournalRecord[] {
  return includeAll
    ? [...records]
    : records.filter((record) => !isLifecycleNoise(record));
}

export function renderLine(record: JournalRecord): string {
  return `${record.priority <= 3 ? "! " : ""}${record.message}`;
}

export function renderOutput(
  records: JournalRecord[],
  limit: number,
): { lines: string[]; omitted: number } {
  const omitted = Math.max(0, records.length - limit);
  return {
    lines: (omitted ? records.slice(-limit) : records).map(renderLine),
    omitted,
  };
}

/** The same trailing window as renderOutput, without the `! ` severity prefix the model uses. */
export function terminalOutput(
  records: JournalRecord[],
  limit: number,
): string[] {
  return (records.length > limit ? records.slice(-limit) : records).map(
    (record) => record.message,
  );
}

/** systemd unloads a transient unit that exited cleanly, so the journal carries its verdict. */
export function inferOutcome(records: JournalRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const message = records[index].message;
    const failed = /Failed with result '([^']+)'/.exec(message);
    if (failed) return `failed (result ${failed[1]})`;
    if (message.includes("Deactivated successfully"))
      return "finished (exit 0)";
  }
  return undefined;
}
