import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import systemdBackground from "../index.ts";

type Result = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: Result) => void) | undefined,
    ctx: { cwd: string },
  ) => Promise<Result>;
};

const tools = new Map<string, Tool>();
const shutdowns: Array<() => void> = [];
const pi = {
  registerTool: (tool: Tool) => tools.set(tool.name, tool),
  on: (event: string, handler: () => void) => {
    if (event === "session_shutdown") shutdowns.push(handler);
    return () => {};
  },
};
systemdBackground(pi as never);

const bg = tools.get("bg");
if (!bg) throw new Error("bg tool was not registered");

async function call(
  params: Record<string, unknown>,
  onUpdate?: (r: Result) => void,
): Promise<Result> {
  const result = await bg.execute("smoke", params, undefined, onUpdate, {
    cwd: "/tmp",
  });
  const label = `${String(params.action)}${params.follow ? " follow" : ""}${params.id ? ` ${String(params.id)}` : ""}`;
  console.log(
    `\n--- ${label}${result.isError ? " [ERROR]" : ""}\n${result.content[0].text}`,
  );
  return result;
}

const first = await call({
  action: "start",
  name: "smoke",
  command: "echo one; sleep 1; echo two 1>&2; sleep 1; echo three",
});
const id = String(
  first.content[0].text.match(/(pi-systemd-[a-z0-9.-]+)/)?.[1] ?? "",
);
if (!id) throw new Error("no unit id in the start result");

await call({ action: "output", id, timeout: 2 });
let updates = 0;
await call({ action: "output", id, follow: true, timeout: 20 }, () => {
  updates++;
});
console.log(`\nstreamed updates: ${updates}`);
await call({ action: "status", id });

const failing = await call({
  action: "start",
  name: "boom",
  command: "echo out; echo boom 1>&2; exit 3",
});
const failingId = String(
  failing.content[0].text.match(/(pi-systemd-[a-z0-9.-]+)/)?.[1] ?? "",
);
await call({ action: "output", id: failingId, follow: true, timeout: 20 });

const long = await call({
  action: "start",
  name: "long",
  command: "while true; do echo tick; sleep 1; done",
});
const longId = String(
  long.content[0].text.match(/(pi-systemd-[a-z0-9.-]+)/)?.[1] ?? "",
);
await call({ action: "output", id: longId, follow: true, timeout: 3 });
await call({ action: "stop", id: longId });
await call({ action: "list" });

for (const unit of [id, failingId, longId]) {
  await call({ action: "status", id: unit });
}

const fixture = join(tmpdir(), "pi-systemd-smoke.json");
writeFileSync(
  fixture,
  JSON.stringify({
    properties: { NoNewPrivileges: true },
    presets: {
      sandboxed: {
        ProtectSystem: "strict",
        PrivateTmp: true,
        ReadOnlyPaths: ["/usr", "/etc"],
        MemoryMax: 268435456,
        RuntimeMaxSec: 30,
      },
    },
  }),
);
process.env.PI_SYSTEMD_CONFIG = fixture;

const sandboxed = await call({
  action: "start",
  name: "sandbox",
  command:
    "echo hello from a sandbox; echo writable? > /usr/pi-smoke 2>/dev/null || echo /usr is read-only",
  preset: "sandboxed",
  properties: { ExecStartPre: "echo preparing", ProtectHome: "tmpfs" },
});
const sandboxId = String(
  sandboxed.content[0].text.match(/(pi-systemd-[a-z0-9.-]+)/)?.[1] ?? "",
);
await call({ action: "output", id: sandboxId, follow: true, timeout: 20 });
await call({ action: "status", id: sandboxId });

await call({
  action: "start",
  name: "badprop",
  command: "echo hi",
  properties: { ProtectSytem: "strict" },
});

await call({
  action: "start",
  name: "badbool",
  command: "echo hi",
  properties: { NoNewPrivileges: "maybe" },
});

await call({
  action: "start",
  name: "badpreset",
  command: "echo hi",
  preset: "nope",
});

for (const shutdown of shutdowns) shutdown();
console.log("\nsmoke done");
