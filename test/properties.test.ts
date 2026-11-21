import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inferSignature,
  parseBoolean,
  resolveProperties,
  timeAlias,
} from "../src/properties.ts";

const signatures = new Map<string, string>([
  ["NoNewPrivileges", "b"],
  ["ProtectSystem", "s"],
  ["MemoryMax", "t"],
  ["UMask", "u"],
  ["Environment", "as"],
  ["ReadOnlyPaths", "as"],
  ["ExecStartPre", "a(sasbttttuii)"],
  ["RuntimeMaxUSec", "t"],
  ["BindPaths", "a(ssbt)"],
]);

const named = (input: Record<string, string | number | boolean | string[]>) =>
  Object.fromEntries(
    resolveProperties(input, signatures).resolved.map((entry) => [
      entry.name,
      [entry.signature, entry.value],
    ]),
  );

describe("parseBoolean", () => {
  it("accepts the unit file spellings", () => {
    for (const word of ["yes", "true", "on", "1", "YES"]) {
      assert.equal(parseBoolean(word, "x"), true);
    }
    for (const word of ["no", "false", "off", "0"]) {
      assert.equal(parseBoolean(word, "x"), false);
    }
    assert.equal(parseBoolean(true, "x"), true);
  });

  it("rejects anything else, naming the property", () => {
    assert.throws(
      () => parseBoolean("maybe", "NoNewPrivileges"),
      /NoNewPrivileges/,
    );
  });
});

describe("timeAlias", () => {
  it("maps a unit file duration onto systemd's microsecond property", () => {
    assert.equal(timeAlias("RuntimeMaxSec", signatures), "RuntimeMaxUSec");
    assert.equal(timeAlias("ProtectSystem", signatures), undefined);
    assert.equal(timeAlias("TimeoutStopSec", signatures), undefined);
  });
});

describe("inferSignature", () => {
  it("guesses from the value type when introspection is silent", () => {
    assert.equal(inferSignature(true), "b");
    assert.equal(inferSignature(5), "t");
    assert.equal(inferSignature(["a"]), "as");
    assert.equal(inferSignature("a"), "s");
  });
});

describe("resolveProperties", () => {
  it("uses the introspected signature and converts values", () => {
    assert.deepEqual(
      named({ NoNewPrivileges: "yes", ProtectSystem: "strict" }),
      {
        NoNewPrivileges: ["b", true],
        ProtectSystem: ["s", "strict"],
      },
    );
  });

  it("parses numbers given as strings", () => {
    assert.deepEqual(named({ MemoryMax: "268435456", UMask: 18 }), {
      MemoryMax: ["t", 268435456],
      UMask: ["u", 18],
    });
  });

  it("converts seconds to the microsecond property", () => {
    assert.deepEqual(named({ RuntimeMaxSec: 30 }), {
      RuntimeMaxUSec: ["t", 30_000_000],
    });
  });

  it("accepts a bare string for a list property", () => {
    assert.deepEqual(named({ ReadOnlyPaths: "/usr" }), {
      ReadOnlyPaths: ["as", ["/usr"]],
    });
  });

  it("builds the exec struct systemd expects", () => {
    assert.deepEqual(named({ ExecStartPre: "echo preparing" }), {
      ExecStartPre: [
        "a(sasb)",
        [["/bin/sh", ["/bin/sh", "-c", "echo preparing"], false]],
      ],
    });
  });

  it("reports unlisted properties instead of guessing silently", () => {
    const { resolved, inferred } = resolveProperties(
      { SomeFutureKnob: true },
      signatures,
    );
    assert.deepEqual(inferred, ["SomeFutureKnob"]);
    assert.deepEqual(resolved, [
      { name: "SomeFutureKnob", signature: "b", value: true },
    ]);
  });

  it("refuses a property whose D-Bus type cannot come from a plain value", () => {
    assert.throws(
      () => resolveProperties({ BindPaths: "/tmp" }, signatures),
      /BindPaths/,
    );
  });
});
