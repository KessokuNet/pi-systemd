import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JournalRecord } from "../src/journald.ts";
import {
  inferOutcome,
  isLifecycleNoise,
  renderOutput,
  selectRecords,
  terminalOutput,
} from "../src/output.ts";

const record = (
  message: string,
  options: Partial<JournalRecord> = {},
): JournalRecord => ({
  message,
  priority: 6,
  managerLine: false,
  ...options,
});

describe("isLifecycleNoise", () => {
  it("drops systemd start and stop bookkeeping", () => {
    assert.equal(
      isLifecycleNoise(record("Starting x.service...", { managerLine: true })),
      true,
    );
    assert.equal(
      isLifecycleNoise(
        record("Deactivated successfully.", { managerLine: true }),
      ),
      true,
    );
  });

  it("keeps failures and the unit output", () => {
    assert.equal(
      isLifecycleNoise(
        record("Failed with result 'exit-code'.", { managerLine: true }),
      ),
      false,
    );
    assert.equal(isLifecycleNoise(record("Starting x.service...")), false);
  });
});

describe("selectRecords", () => {
  it("filters noise by default and keeps everything when asked", () => {
    const records = [
      record("Started x.service.", { managerLine: true }),
      record("hello"),
    ];
    assert.deepEqual(
      selectRecords(records).map((r) => r.message),
      ["hello"],
    );
    assert.equal(selectRecords(records, true).length, 2);
  });
});

describe("renderOutput", () => {
  it("keeps the trailing lines and counts the rest", () => {
    const records = ["a", "b", "c"].map((message) => record(message));
    assert.deepEqual(renderOutput(records, 2), {
      lines: ["b", "c"],
      omitted: 1,
    });
    assert.deepEqual(renderOutput(records, 5), {
      lines: ["a", "b", "c"],
      omitted: 0,
    });
  });

  it("flags error priorities", () => {
    assert.deepEqual(renderOutput([record("boom", { priority: 3 })], 5).lines, [
      "! boom",
    ]);
  });
});

describe("terminalOutput", () => {
  it("keeps the trailing lines without the severity prefix", () => {
    const records = [
      record("old"),
      record("boom", { priority: 3 }),
      record("new"),
    ];
    assert.deepEqual(terminalOutput(records, 2), ["boom", "new"]);
    assert.deepEqual(terminalOutput(records, 5), ["old", "boom", "new"]);
  });
});

describe("inferOutcome", () => {
  it("reads the failure from the manager line", () => {
    const records = [
      record("out"),
      record("x.service: Failed with result 'exit-code'.", {
        managerLine: true,
      }),
    ];
    assert.equal(inferOutcome(records), "failed (result exit-code)");
  });

  it("recognises a clean deactivation", () => {
    assert.equal(
      inferOutcome([record("x.service: Deactivated successfully.")]),
      "finished (exit 0)",
    );
  });

  it("returns nothing when the journal has no verdict", () => {
    assert.equal(inferOutcome([record("hello")]), undefined);
    assert.equal(inferOutcome([]), undefined);
  });
});
