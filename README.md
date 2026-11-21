# pi-systemd

A pi extension that runs long commands as **transient systemd user units** and reads their output from **the journal**.

Pi's built-in `bash` tool blocks until the command finishes and has no background mode. This extension fills that gap with systemd instead of a detached child process: the work belongs to the user manager, so it survives the session, is queryable by name, and its stdout/stderr are stored in the journal rather than in a log file this process has to keep open.

## How it works

- **Starting a unit** goes straight to the user manager over D-Bus (`org.freedesktop.systemd1.Manager.StartTransientUnit` via `dbus-next`), with property reads through `org.freedesktop.DBus.Properties`. No `systemd-run` subprocess, no shell in between.
- **Reading output** goes through `libsystemd` with `koffi`: `sd_journal_open`, a match on `_SYSTEMD_USER_UNIT=<unit>` OR `USER_UNIT=<unit>`, then `seek_cursor`/`next`/`get_data`. Unit output and the manager's own lifecycle lines both match, and `_SYSTEMD_USER_UNIT` distinguishes them, so "Starting …"/"Started …" noise can be filtered while failures are kept.
- **Fallback**: when `libsystemd` or `koffi` is unavailable (non-Linux, containers), reads fall back to `journalctl --user -u <unit> -o json`, still cursor-based and still without a shell.

Unit ids are `pi-systemd-<slug>-<hex4>`, unique per start, so the journal for an id only ever contains that run. Units that exit cleanly are unloaded by systemd; their verdict is recovered from the journal, and failures stay queryable until `systemctl --user reset-failed` clears them.

## Usage

The extension registers one tool, `bg`:

| Action   | Parameters                                                   | Result                                                 |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `start`  | `command`, `name?`, `cwd?`, `env?`, `properties?`, `preset?` | id, systemd state, output so far                       |
| `output` | `id`, `follow?`, `timeout?`, `lines?`, `all?`                | trailing output; `follow` streams until the unit exits |
| `status` | `id`                                                         | state, command, cwd, start time, properties            |
| `stop`   | `id`                                                         | stops the unit, then reports its final output          |
| `list`   | –                                                            | units this tool created, with their state              |

`timeout` means "seconds to wait" for `output`. `lines` (default 200) caps how much trailing output is shown; `all` includes systemd's lifecycle lines. A runtime limit on `start` is a property, not a parameter: `properties: { RuntimeMaxSec: 30 }`.

## systemd properties

`start` takes any writable systemd unit property through `properties`:

```
properties: {
  NoNewPrivileges: true,
  ProtectSystem: "strict",
  PrivateTmp: true,
  ReadOnlyPaths: ["/usr", "/etc"],
  MemoryMax: 268435456,
  TasksMax: 64,
  ExecStartPre: "echo preparing"
}
```

Booleans accept `true`, `yes`, `on` and `1`. A name ending in `…Sec` is sent as systemd's `…USec` property in microseconds, so `RuntimeMaxSec: 30` means what the unit file spelling means. `ExecStartPre`, `ExecStartPost`, `ExecStop`, `ExecStopPost` and `ExecReload` take one command or a list, run through `/bin/sh -c`. `properties.Environment` replaces the inherited environment.

The D-Bus type of each property comes from systemd's own introspection of a live service unit, so values are converted to what systemd expects rather than guessed. A misspelled property is rejected by systemd with its own message (`Cannot set property ProtectSytem, or unknown property.`); a property newer than the installed systemd that introspection cannot describe is still sent, with an inferred type and a note in the result.

### Shared defaults and presets

`~/.pi/agent/extensions/pi-systemd.json` (override with `PI_SYSTEMD_CONFIG`):

```json
{
  "properties": { "NoNewPrivileges": true },
  "presets": {
    "sandboxed": {
      "ProtectSystem": "strict",
      "ProtectHome": "tmpfs",
      "PrivateTmp": true,
      "ReadOnlyPaths": ["/usr", "/etc"],
      "MemoryMax": 268435456
    }
  }
}
```

`properties` applies to every unit this tool starts. `presets` are named sets a call picks with `preset`. Precedence is per-call `properties` over `preset` over the shared `properties`. A malformed config file is reported in the `start` result and otherwise ignored.

## Install

```
pi install /path/to/pi-systemd
```

The package needs Node 20+ and a running systemd user manager (`systemctl --user is-system-running`). Linger is recommended so units outlive the login session:

```
loginctl enable-linger "$USER"
```

## Notes for the model

`GUIDANCE` in `index.ts` is attached to the tool description: prefer `bg` over `bash` for anything long-running, prefer `follow` over repeated `output` polls, stop units by id rather than killing PIDs, and put sandboxing and resource limits in `properties` rather than reaching for a container.
