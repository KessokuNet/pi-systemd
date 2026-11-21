import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEnvironment,
  buildExecStart,
  describeCommand,
  formatState,
  mapUnitState,
  newUnitId,
  normalizeUnitId,
  sanitizeSlug,
  unitName,
  UNIT_ID_RE,
} from "../src/units.ts";

describe("sanitizeSlug", () => {
  it("lowercases and replaces runs of invalid characters", () => {
    assert.equal(sanitizeSlug("Cargo Build/Fix  #12"), "cargo-build-fix-12");
  });

  it("strips leading and trailing separators", () => {
    assert.equal(sanitizeSlug("--weird--"), "weird");
  });

  it("caps the slug length", () => {
    assert.equal(sanitizeSlug("x".repeat(80)).length, 40);
  });
});

describe("newUnitId", () => {
  it("produces ids that match the unit id pattern", () => {
    assert.match(newUnitId("cargo-build"), UNIT_ID_RE);
    assert.match(newUnitId(), UNIT_ID_RE);
  });

  it("carries the slug through", () => {
    assert.match(
      newUnitId("cargo-build"),
      /^pi-systemd-cargo-build-[0-9a-f]{4}$/,
    );
  });
});

describe("normalizeUnitId", () => {
  it("accepts an id with or without the service suffix", () => {
    assert.equal(
      normalizeUnitId("pi-systemd-cargo-1a2b"),
      "pi-systemd-cargo-1a2b",
    );
    assert.equal(
      normalizeUnitId("pi-systemd-cargo-1a2b.service"),
      "pi-systemd-cargo-1a2b",
    );
  });

  it("rejects foreign units and junk", () => {
    assert.equal(normalizeUnitId("sshd.service"), undefined);
    assert.equal(normalizeUnitId("pi-systemd-../evil"), undefined);
    assert.equal(normalizeUnitId(""), undefined);
  });
});

describe("unitName", () => {
  it("appends the service suffix", () => {
    assert.equal(unitName("pi-systemd-1a2b"), "pi-systemd-1a2b.service");
  });
});

describe("describeCommand", () => {
  it("collapses whitespace and prefixes the description", () => {
    assert.equal(
      describeCommand("  cargo\tbuild\n--release "),
      "pi-systemd: cargo build --release",
    );
  });

  it("truncates long commands", () => {
    const described = describeCommand("echo " + "a".repeat(400));
    assert.ok(described.length <= 120, `too long: ${described.length}`);
    assert.ok(described.endsWith("…"));
  });
});

describe("buildExecStart", () => {
  it("runs the command through a shell", () => {
    const [executable, argv, ignoreFailure] = buildExecStart("echo hi");
    assert.equal(executable, "/bin/sh");
    assert.deepEqual(argv, ["/bin/sh", "-c", "echo hi"]);
    assert.equal(ignoreFailure, false);
  });
});

describe("buildEnvironment", () => {
  it("carries the host PATH and lets the caller override it", () => {
    const carried = buildEnvironment(undefined, {
      PATH: "/usr/bin",
      HOME: "/home/x",
    });
    assert.deepEqual(carried, ["PATH=/usr/bin", "HOME=/home/x"]);
    const overridden = buildEnvironment(
      { PATH: "/opt/bin" },
      { PATH: "/usr/bin" },
    );
    assert.deepEqual(overridden, ["PATH=/opt/bin"]);
  });
});

describe("mapUnitState", () => {
  it("treats activating as active but not done", () => {
    const state = mapUnitState({
      ActiveState: "activating",
      SubState: "start",
    });
    assert.equal(state.active, true);
    assert.equal(state.done, false);
    assert.equal(state.failed, false);
  });

  it("reports a failed unit with its exit code", () => {
    const state = mapUnitState({
      ActiveState: "failed",
      SubState: "failed",
      Result: "exit-code",
      ExecMainStatus: 3,
    });
    assert.equal(state.done, true);
    assert.equal(state.failed, true);
    assert.equal(state.exitCode, 3);
    assert.equal(formatState(state), "failed/failed result=exit-code exit=3");
  });

  it("hides the exit code while the unit is still running", () => {
    assert.equal(
      formatState(mapUnitState({ ActiveState: "active", SubState: "running" })),
      "active/running",
    );
  });
});
