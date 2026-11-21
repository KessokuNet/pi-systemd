import dbus from "dbus-next";
import type { ResolvedProperty } from "./properties.ts";
import { mapUnitState, type RawUnitState, type UnitState } from "./units.ts";

const SYSTEMD = "org.freedesktop.systemd1";
const MANAGER_PATH = "/org/freedesktop/systemd1";
const MANAGER_IFACE = "org.freedesktop.systemd1.Manager";
const UNIT_IFACE = "org.freedesktop.systemd1.Unit";
const SERVICE_IFACE = "org.freedesktop.systemd1.Service";
const PROPERTIES_IFACE = "org.freedesktop.DBus.Properties";
const INTROSPECT_IFACE = "org.freedesktop.DBus.Introspectable";

/** Sandboxing and resource properties worth reporting back when a unit sets them. */
export const NOTABLE_PROPERTIES = [
  "User",
  "Group",
  "DynamicUser",
  "NoNewPrivileges",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "PrivateDevices",
  "PrivateNetwork",
  "PrivateUsers",
  "ProtectKernelTunables",
  "ProtectKernelModules",
  "ProtectControlGroups",
  "ProtectClock",
  "ProtectHostname",
  "ProtectProc",
  "RestrictNamespaces",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "LockPersonality",
  "MemoryDenyWriteExecute",
  "CapabilityBoundingSet",
  "SystemCallFilter",
  "ReadWritePaths",
  "ReadOnlyPaths",
  "InaccessiblePaths",
  "MemoryMax",
  "MemoryHigh",
  "CPUWeight",
  "IOWeight",
  "TasksMax",
  "Slice",
  "Nice",
  "UMask",
];

export type StartOptions = {
  unit: string;
  description: string;
  execStart: [string, string[], boolean];
  cwd: string;
  environment: string[];
  /** Extra systemd properties, already resolved to a D-Bus signature and value. */
  properties?: ResolvedProperty[];
};

export type ListedUnit = {
  unit: string;
  description: string;
  active: string;
  sub: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    // 2^64-1 is how systemd spells "infinity" for the resource properties.
    return value !== 0 && String(value) !== "18446744073709551615";
  }
  if (typeof value === "string") {
    return (
      value.length > 0 &&
      value !== "default" &&
      value !== "no" &&
      value !== "false"
    );
  }
  if (Array.isArray(value)) {
    return value.length > 0 && value.some((entry) => String(entry) !== "false");
  }
  return false;
}

/** The user manager, addressed directly over the session bus (D-Bus, not the systemctl CLI). */
export class SystemdUserBus {
  private signatureCache: Map<string, string> | undefined;

  private constructor(
    private readonly bus: dbus.MessageBus,
    private readonly manager: dbus.ClientInterface,
  ) {}

  static async connect(): Promise<SystemdUserBus> {
    const bus = dbus.sessionBus();
    const root = await bus.getProxyObject(SYSTEMD, MANAGER_PATH);
    return new SystemdUserBus(bus, root.getInterface(MANAGER_IFACE));
  }

  private async propertiesFor(
    unit: string,
  ): Promise<dbus.ClientInterface | undefined> {
    let path: unknown;
    try {
      path = await this.manager.GetUnit(unit);
    } catch (error) {
      // Only a missing unit means gone; other D-Bus failures must not look like completion.
      if (
        (error as { type?: unknown }).type ===
        "org.freedesktop.systemd1.NoSuchUnit"
      ) {
        return undefined;
      }
      throw error;
    }
    if (typeof path !== "string") return undefined;
    const object = await this.bus.getProxyObject(SYSTEMD, path);
    return object.getInterface(PROPERTIES_IFACE);
  }

  private async read(
    properties: dbus.ClientInterface,
    iface: string,
    name: string,
  ): Promise<unknown> {
    try {
      const entry = (await properties.Get(iface, name)) as { value?: unknown };
      return entry?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Property name to D-Bus signature, from systemd's own introspection of a live service unit. The
   * Service vtable is shared by every unit, so one sample describes every property of ours.
   */
  async servicePropertyTypes(): Promise<Map<string, string>> {
    if (this.signatureCache) return this.signatureCache;
    const signatures = new Map<string, string>();
    try {
      const sample = (await this.listUnits("")).find((entry) =>
        entry.unit.endsWith(".service"),
      );
      if (sample) {
        const path = await this.manager.GetUnit(sample.unit);
        if (typeof path === "string") {
          const object = await this.bus.getProxyObject(SYSTEMD, path);
          const introspect = object.getInterface(INTROSPECT_IFACE);
          const xml = String(await introspect.Introspect());
          const iface =
            /<interface name="org\.freedesktop\.systemd1\.Service">([\s\S]*?)<\/interface>/.exec(
              xml,
            );
          for (const match of iface?.[1].matchAll(
            /<property name="([^"]+)" type="([^"]+)"/g,
          ) ?? []) {
            signatures.set(match[1], match[2]);
          }
        }
      }
    } catch {
      // Introspection is a convenience; unlisted properties fall back to inference.
    }
    this.signatureCache = signatures;
    return signatures;
  }

  /** Every org.freedesktop.systemd1.Service property of a live unit, in one round trip. */
  async unitPropertyValues(unit: string): Promise<Record<string, unknown>> {
    const properties = await this.propertiesFor(unit);
    if (!properties) return {};
    try {
      const all = (await properties.GetAll(SERVICE_IFACE)) as Record<
        string,
        { value?: unknown }
      >;
      return Object.fromEntries(
        Object.entries(all ?? {}).map(([name, entry]) => [name, entry?.value]),
      );
    } catch {
      return {};
    }
  }

  /** The sandboxing and resource properties a unit actually set, ignoring systemd's defaults. */
  async notableProperties(unit: string): Promise<Record<string, unknown>> {
    const values = await this.unitPropertyValues(unit);
    const notable: Record<string, unknown> = {};
    for (const name of NOTABLE_PROPERTIES) {
      if (asBooleanLike(values[name])) notable[name] = values[name];
    }
    return notable;
  }

  /** State of a unit, or undefined when systemd no longer knows it (collected or never started). */
  async unitState(unit: string): Promise<UnitState | undefined> {
    const properties = await this.propertiesFor(unit);
    if (!properties) return undefined;
    const raw: RawUnitState = {
      ActiveState: asString(
        await this.read(properties, UNIT_IFACE, "ActiveState"),
      ),
      SubState: asString(await this.read(properties, UNIT_IFACE, "SubState")),
      Result: asString(await this.read(properties, SERVICE_IFACE, "Result")),
      ExecMainStatus: asNumber(
        await this.read(properties, SERVICE_IFACE, "ExecMainStatus"),
      ),
    };
    return mapUnitState(raw);
  }

  async startTransientUnit(options: StartOptions): Promise<string> {
    const properties: Array<[string, dbus.Variant]> = [
      ["Description", new dbus.Variant("s", options.description)],
      ["Type", new dbus.Variant("s", "exec")],
      ["ExecStart", new dbus.Variant("a(sasb)", [options.execStart])],
      ["WorkingDirectory", new dbus.Variant("s", options.cwd)],
      ["StandardOutput", new dbus.Variant("s", "journal")],
      ["StandardError", new dbus.Variant("s", "journal")],
    ];
    if (options.environment.length) {
      properties.push([
        "Environment",
        new dbus.Variant("as", options.environment),
      ]);
    }
    for (const property of options.properties ?? []) {
      const entry: [string, dbus.Variant] = [
        property.name,
        new dbus.Variant(property.signature, property.value),
      ];
      const index = properties.findIndex(([name]) => name === property.name);
      if (index === -1) properties.push(entry);
      else properties[index] = entry;
    }
    const jobPath = await this.manager.StartTransientUnit(
      options.unit,
      "replace",
      properties,
      [],
    );
    return typeof jobPath === "string" ? jobPath : "";
  }

  async stopUnit(unit: string): Promise<void> {
    await this.manager.StopUnit(unit, "replace");
  }

  async resetFailedUnit(unit: string): Promise<void> {
    await this.manager.ResetFailedUnit(unit);
  }

  /** Units currently known to the manager whose name starts with `prefix`, including inactive ones. */
  async listUnits(prefix: string): Promise<ListedUnit[]> {
    const rows = (await this.manager.ListUnits()) as unknown;
    if (!Array.isArray(rows)) return [];
    const listed: ListedUnit[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const unit = asString(row[0]);
      if (!unit?.startsWith(prefix)) continue;
      listed.push({
        unit,
        description: asString(row[1]) ?? "",
        active: asString(row[3]) ?? "",
        sub: asString(row[4]) ?? "",
      });
    }
    return listed;
  }

  async unitStartTimestamp(unit: string): Promise<number | undefined> {
    const properties = await this.propertiesFor(unit);
    if (!properties) return undefined;
    return asNumber(
      await this.read(properties, UNIT_IFACE, "ActiveEnterTimestamp"),
    );
  }

  disconnect(): void {
    try {
      this.bus.disconnect();
    } catch {
      // The bus is already gone.
    }
  }
}
