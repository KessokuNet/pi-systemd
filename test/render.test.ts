import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBgCall, renderBgResult } from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const context = {
  lastComponent: undefined,
  keyHint: (_keybinding: "app.tools.expand", description: string) =>
    `ctrl+o ${description}`,
};

const output = (count: number) => ({
  content: [
    {
      type: "text",
      text: Array.from(
        { length: count },
        (_, index) => `line ${index + 1}`,
      ).join("\n"),
    },
  ],
});

const running = {
  active: true,
  done: false,
  state: "active",
  sub: "running",
  failed: false,
};

describe("renderBgCall", () => {
  it("shows the shell command and the unit name", () => {
    const rendered = renderBgCall(
      { action: "start", command: "just test", name: "tests" },
      theme,
      context,
    )
      .render(80)
      .join("\n");
    assert.match(rendered, /bg start \$ just test/);
    assert.match(rendered, /\(tests\)/);
  });

  it("shows the unit and the follow state", () => {
    const rendered = renderBgCall(
      { action: "output", id: "pi-systemd-tests-ab12", follow: true },
      theme,
      context,
    )
      .render(80)
      .join("\n");
    assert.match(rendered, /bg output pi-systemd-tests-ab12/);
    assert.match(rendered, /\(following\)/);
  });
});

describe("renderBgResult", () => {
  it("keeps the last lines and hints at the rest", () => {
    const rendered = renderBgResult(
      output(12),
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");
    assert.ok(rendered.includes("line 12"));
    assert.ok(rendered.includes("line 8"));
    assert.ok(!rendered.includes("line 7"));
    assert.match(rendered, /7 earlier lines, ctrl\+o to expand/);
  });

  it("shows the whole log when expanded", () => {
    const rendered = renderBgResult(
      output(12),
      { expanded: true, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");
    assert.ok(rendered.includes("line 1"));
    assert.ok(rendered.includes("line 12"));
    assert.ok(!rendered.includes("earlier lines"));
  });

  it("shows nothing for an empty result", () => {
    const rendered = renderBgResult(
      { content: [] },
      { expanded: false, isPartial: true },
      theme,
      context,
    ).render(80);
    assert.deepEqual(rendered, []);
  });

  it("renders a service card with its state, metadata and log tail", () => {
    const rendered = renderBgResult(
      {
        content: [
          {
            type: "text",
            text: [
              "started pi-systemd-tests-ab12.service (cwd /srv/app)",
              "properties: MemoryMax=1",
              "pi-systemd-tests-ab12.service: active/running",
              "line 1",
              "line 2",
              "line 3",
              "line 4",
              "line 5",
              "line 6",
              "line 7",
              "line 8",
            ].join("\n"),
          },
        ],
        details: {
          id: "pi-systemd-tests-ab12",
          unit: "pi-systemd-tests-ab12.service",
          state: running,
          meta: ["cwd /srv/app", "properties: MemoryMax=1"],
          output: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`),
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");

    assert.match(
      rendered,
      /● pi-systemd-tests-ab12\.service {2}active\/running/,
    );
    assert.match(rendered, /cwd \/srv\/app/);
    assert.match(rendered, /properties: MemoryMax=1/);
    assert.ok(rendered.includes("line 8"));
    assert.ok(!rendered.includes("line 3"));
    assert.match(rendered, /3 earlier lines, ctrl\+o to expand/);
    assert.ok(!rendered.includes("started pi-systemd"));
  });

  it("marks a failed unit and reports lines dropped by the lines limit", () => {
    const rendered = renderBgResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          unit: "pi-systemd-boom-ab12.service",
          output: ["error: boom"],
          omitted: 3,
          state: {
            active: false,
            done: true,
            state: "failed",
            sub: "failed",
            result: "exit-code",
            exitCode: 101,
            failed: true,
          },
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");

    assert.match(rendered, /✗ pi-systemd-boom-ab12\.service {2}failed\/failed/);
    assert.match(rendered, /result=exit-code exit=101/);
    assert.match(rendered, /error: boom/);
    assert.match(rendered, /… 3 earlier lines omitted/);
  });

  it("falls back to the text when the unit state is unknown", () => {
    const rendered = renderBgResult(
      {
        content: [
          {
            type: "text",
            text: "pi-systemd-gone-ab12.service: no such unit and no output found",
          },
        ],
        details: { unit: "pi-systemd-gone-ab12.service", meta: [] },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");
    assert.match(rendered, /no such unit and no output found/);
  });

  it("renders list rows with their unit state", () => {
    const rendered = renderBgResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          units: [
            {
              unit: "pi-systemd-a.service",
              active: "active",
              sub: "running",
              command: "just dev",
            },
            {
              unit: "pi-systemd-b.service",
              active: "failed",
              sub: "failed",
              command: "just test",
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    )
      .render(80)
      .join("\n");

    assert.match(
      rendered,
      /● pi-systemd-a\.service {2}active\/running {2}just dev/,
    );
    assert.match(
      rendered,
      /✗ pi-systemd-b\.service {2}failed\/failed {2}just test/,
    );
  });

  it("shows elapsed time while following and the tool duration once settled", () => {
    const state = { startedAt: Date.now() - 5400 };
    const result = {
      content: [{ type: "text", text: "tick" }],
      details: {
        unit: "pi-systemd-tests-ab12.service",
        state: running,
        output: ["tick"],
      },
    };
    const partial = renderBgResult(
      result,
      { expanded: false, isPartial: true },
      theme,
      { ...context, state, args: { action: "output" } },
    )
      .render(80)
      .join("\n");
    assert.match(partial, /Elapsed \d+\.\ds/);

    const final = renderBgResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      { ...context, state, args: { action: "output" }, durationMs: 12_000 },
    )
      .render(80)
      .join("\n");
    assert.match(final, /Took 12\.0s/);
  });

  it("does not time a start call, whose duration is not the unit's", () => {
    const rendered = renderBgResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          unit: "pi-systemd-tests-ab12.service",
          state: running,
          output: [],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { ...context, state: {}, args: { action: "start" }, durationMs: 4200 },
    )
      .render(80)
      .join("\n");
    assert.ok(!rendered.includes("Took"));
  });
});
