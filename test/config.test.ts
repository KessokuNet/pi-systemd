import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, loadConfig, mergeProperties } from "../src/config.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-systemd-config-"));

const write = (name: string, contents: string): string => {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
};

describe("configPath", () => {
  it("sits beside the other extension configs and honours the override", () => {
    assert.equal(configPath("/agent", {}), "/agent/extensions/pi-systemd.json");
    assert.equal(
      configPath("/agent", { PI_SYSTEMD_CONFIG: "/tmp/x.json" }),
      "/tmp/x.json",
    );
  });
});

describe("loadConfig", () => {
  it("treats a missing file as empty configuration", () => {
    const { config, error } = loadConfig("/nonexistent-agent-dir", {});
    assert.deepEqual(config, { properties: {}, presets: {} });
    assert.equal(error, undefined);
  });

  it("reads shared properties and named presets", () => {
    const path = write(
      "good.json",
      JSON.stringify({
        properties: { NoNewPrivileges: true },
        presets: {
          sandboxed: { ProtectSystem: "strict", ReadOnlyPaths: ["/usr"] },
        },
      }),
    );
    const { config, error } = loadConfig("/x", { PI_SYSTEMD_CONFIG: path });
    assert.equal(error, undefined);
    assert.deepEqual(config.properties, { NoNewPrivileges: true });
    assert.deepEqual(config.presets.sandboxed, {
      ProtectSystem: "strict",
      ReadOnlyPaths: ["/usr"],
    });
  });

  it("reports malformed JSON and falls back to empty configuration", () => {
    const path = write("broken.json", "{ oops");
    const { config, error } = loadConfig("/x", { PI_SYSTEMD_CONFIG: path });
    assert.deepEqual(config, { properties: {}, presets: {} });
    assert.match(String(error), /broken\.json/);
  });

  it("rejects a property value that cannot be sent over D-Bus", () => {
    const path = write(
      "bad-value.json",
      JSON.stringify({ properties: { ProtectSystem: { nested: true } } }),
    );
    const { error } = loadConfig("/x", { PI_SYSTEMD_CONFIG: path });
    assert.match(String(error), /ProtectSystem/);
  });

  it("rejects a presets value that is not an object", () => {
    const path = write(
      "bad-presets.json",
      JSON.stringify({ presets: ["nope"] }),
    );
    const { error } = loadConfig("/x", { PI_SYSTEMD_CONFIG: path });
    assert.match(String(error), /presets/);
  });
});

describe("mergeProperties", () => {
  it("applies later layers over earlier ones and skips undefined", () => {
    assert.deepEqual(mergeProperties({ a: 1, b: 2 }, undefined, { b: 3 }), {
      a: 1,
      b: 3,
    });
  });
});
