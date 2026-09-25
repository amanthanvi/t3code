import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Best-effort hardware detection for the environment icon. Every probe is
 * allowed to fail: a null result means "no signal", and the client draws a
 * generic server until the user picks something in Settings → Connections.
 */

const DMI_ROOT = "/sys/class/dmi/id";
const KERNEL_RELEASE_PATH = "/proc/sys/kernel/osrelease";
// Docker and Podman each leave a marker file at the root of a container, and a
// runtime sharing the host's cgroup namespace names itself in PID 1's cgroup
// path. Those two are the whole signal. A private cgroup namespace, which is
// the default for containerd, Kubernetes, LXC, and nspawn, reports a bare
// `0::/`, and so does a host whose init leaves PID 1 in the root cgroup, so a
// container with neither a marker file nor a named cgroup reads as a host.
const CONTAINER_MARKER_PATHS = ["/.dockerenv", "/run/.containerenv"];
const INIT_CGROUP_PATH = "/proc/1/cgroup";
const CGROUP_CONTAINER_MARKERS = ["docker", "containerd", "podman", "lxc", "kubepods", "libpod"];

// SMBIOS 3.x System Enclosure types (table 17). Codes that describe a shape
// rather than a machine (docking stations, blades enclosures, IoT gateways)
// fall through to null on purpose.
const DMI_CHASSIS_KINDS: Readonly<Record<string, EnvironmentMachineKind>> = {
  "3": "desktop", // Desktop
  "4": "desktop", // Low Profile Desktop
  "5": "desktop", // Pizza Box
  "6": "desktop", // Mini Tower
  "7": "desktop", // Tower
  "8": "laptop", // Portable
  "9": "laptop", // Laptop
  "10": "laptop", // Notebook
  "13": "desktop", // All in One
  "14": "laptop", // Sub Notebook
  "15": "desktop", // Space-saving
  "16": "desktop", // Lunch Box
  "17": "server", // Main Server Chassis
  "18": "server", // Expansion Chassis
  "19": "server", // SubChassis
  "20": "server", // Bus Expansion Chassis
  "21": "server", // Peripheral Chassis
  "22": "server", // RAID Chassis
  "23": "server", // Rack Mount Chassis
  "24": "server", // Sealed-case PC
  "28": "server", // Blade
  "31": "laptop", // Convertible
  "32": "laptop", // Detachable
  "35": "desktop", // Mini PC
};

// Hypervisors and cloud providers write themselves into the DMI vendor or
// product strings; any hit means the box is a VM, and a VM reads as "cloud"
// regardless of the chassis type the hypervisor fakes. Hyper-V is matched on
// its "Virtual Machine" product, not the "Microsoft Corporation" vendor that
// physical Surface devices share.
const VIRTUALIZATION_MARKERS = [
  "qemu",
  "kvm",
  "bochs",
  "vmware",
  "virtualbox",
  "innotek",
  "xen",
  "parallels",
  "amazon ec2",
  "google compute engine",
  "digitalocean",
  "hetzner",
  "linode",
  "vultr",
  "scaleway",
  "openstack",
  "cloud",
  "virtual machine",
];

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Marketing names and Intel-era model identifiers share these prefixes.
 * Apple silicon identifiers ("Mac16,10") carry no family, so they resolve
 * through the table of shipped models instead.
 */
export function machineKindFromAppleProductName(name: string): EnvironmentMachineKind | null {
  const normalized = name.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (normalized.startsWith("macmini")) return "mac-mini";
  if (normalized.startsWith("macstudio")) return "mac-studio";
  if (normalized.startsWith("macbook")) return "laptop";
  if (normalized.startsWith("imac") || normalized.startsWith("macpro")) return "desktop";
  return APPLE_SILICON_MODELS[normalized] ?? null;
}

// Apple silicon `hw.model` values, which name a generation rather than a
// product line. Marketing names cover these when IOKit has a product node;
// this table covers the Intel-style fallback path on a machine without one.
const APPLE_SILICON_MODELS: Readonly<Record<string, EnvironmentMachineKind>> = {
  "mac13,1": "mac-studio", // Mac Studio (2022)
  "mac13,2": "mac-studio",
  "mac14,3": "mac-mini", // Mac mini (2023)
  "mac14,12": "mac-mini",
  "mac14,13": "mac-studio", // Mac Studio (2023)
  "mac14,14": "mac-studio",
  "mac14,8": "desktop", // Mac Pro (2023)
  "mac14,2": "laptop", // MacBook Air (2022)
  "mac14,15": "laptop", // MacBook Air (2023)
  "mac14,5": "laptop", // MacBook Pro (2023)
  "mac14,6": "laptop",
  "mac14,7": "laptop",
  "mac14,9": "laptop",
  "mac14,10": "laptop",
  "mac15,3": "laptop", // MacBook Pro (2023)
  "mac15,6": "laptop",
  "mac15,7": "laptop",
  "mac15,8": "laptop",
  "mac15,9": "laptop",
  "mac15,10": "laptop",
  "mac15,11": "laptop",
  "mac15,12": "laptop", // MacBook Air (2024)
  "mac15,13": "laptop",
  "mac15,4": "desktop", // iMac (2023)
  "mac15,5": "desktop",
  "mac16,1": "laptop", // MacBook Pro (2024)
  "mac16,5": "laptop",
  "mac16,6": "laptop",
  "mac16,7": "laptop",
  "mac16,8": "laptop",
  "mac16,10": "mac-mini", // Mac mini (2024)
  "mac16,11": "mac-mini",
  "mac16,15": "laptop", // MacBook Pro (2024)
  "mac16,12": "laptop", // MacBook Air (2025)
  "mac16,13": "laptop",
  "mac16,2": "desktop", // iMac (2024)
  "mac16,3": "desktop",
  "mac16,9": "mac-studio", // Mac Studio (2025)
};

/**
 * Windows reports the same SMBIOS enclosure table Linux exposes through DMI,
 * plus the same hypervisor strings in the manufacturer and model fields.
 */
export function machineKindFromWindowsComputerSystem(input: {
  readonly chassisTypes: ReadonlyArray<string>;
  readonly manufacturer: string | null;
  readonly model: string | null;
}): EnvironmentMachineKind | null {
  const vendorAndProduct = `${input.manufacturer ?? ""} ${input.model ?? ""}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) {
    return "cloud";
  }
  for (const chassisType of input.chassisTypes) {
    const kind = DMI_CHASSIS_KINDS[chassisType];
    if (kind !== undefined) return kind;
  }
  return null;
}

/**
 * A container has no DMI to read; PID 1's cgroup or a runtime marker file says
 * so. Only a named runtime counts. Under cgroup v2 a container with a private
 * namespace reads a bare `0::/`, but so does any host whose init leaves PID 1
 * in the root cgroup, which covers WSL 2 and every non-systemd distribution,
 * so that value says nothing on its own.
 */
export function isContainerCgroup(cgroup: string): boolean {
  const lowered = cgroup.trim().toLowerCase();
  return CGROUP_CONTAINER_MARKERS.some((marker) => lowered.includes(marker));
}

export function machineKindFromDmi(input: {
  readonly chassisType: string | null;
  readonly sysVendor: string | null;
  readonly productName: string | null;
}): EnvironmentMachineKind | null {
  const productName = input.productName ?? "";
  const vendorAndProduct = `${input.sysVendor ?? ""} ${productName}`.toLowerCase();
  if (VIRTUALIZATION_MARKERS.some((marker) => vendorAndProduct.includes(marker))) {
    return "cloud";
  }
  // Apple hardware booting Linux (Asahi) still reports the Apple product name.
  const appleKind = machineKindFromAppleProductName(productName);
  if (appleKind !== null) {
    return appleKind;
  }
  return input.chassisType === null ? null : (DMI_CHASSIS_KINDS[input.chassisType] ?? null);
}

const readOptionalFile = Effect.fn("readOptionalFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.map(normalize),
    Effect.orElseSucceed(() => null),
  );
});

const runProbe = Effect.fn("runMachineProbe")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Input;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeout: input.timeout,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? normalize(result.stdout) : null)),
      Effect.orElseSucceed(() => null),
    );
});

// IOKit's `product` node carries the marketing name ("Mac mini (2024)") on
// Apple silicon; Intel Macs lack it, so `hw.model` ("Macmini8,1") is the
// fallback. Both are single-digit-millisecond calls.
const detectDarwinMachineKind = Effect.fn("detectDarwinMachineKind")(function* () {
  const ioreg = yield* runProbe({
    command: "ioreg",
    args: ["-rd1", "-n", "product"],
    timeout: "5 seconds",
  });
  const productName = ioreg?.match(/"product-name"\s*=\s*<"([^"]+)">/)?.[1] ?? null;
  const fromProductName =
    productName === null ? null : machineKindFromAppleProductName(productName);
  if (fromProductName !== null) {
    return fromProductName;
  }
  const model = yield* runProbe({
    command: "sysctl",
    args: ["-n", "hw.model"],
    timeout: "5 seconds",
  });
  return model === null ? null : machineKindFromAppleProductName(model);
});

const fileExists = Effect.fn("fileExists")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
});

const detectLinuxMachineKind = Effect.fn("detectLinuxMachineKind")(function* () {
  const [kernelRelease, chassisType, sysVendor, productName, initCgroup, ...markers] =
    yield* Effect.all([
      readOptionalFile(KERNEL_RELEASE_PATH),
      readOptionalFile(`${DMI_ROOT}/chassis_type`),
      readOptionalFile(`${DMI_ROOT}/sys_vendor`),
      readOptionalFile(`${DMI_ROOT}/product_name`),
      readOptionalFile(INIT_CGROUP_PATH),
      ...CONTAINER_MARKER_PATHS.map(fileExists),
    ]);
  // A container shares its host's kernel and inherits its DMI when it can
  // read it at all, so the runtime marker is checked first. A Docker Desktop
  // container runs on a WSL 2 kernel and would otherwise read as WSL.
  if (markers.some(Boolean) || (initCgroup !== null && isContainerCgroup(initCgroup))) {
    return "container";
  }
  // WSL exposes Microsoft in its kernel release on both WSL 1 and WSL 2.
  // Check it before DMI because WSL 2 presents as a Hyper-V VM.
  if (kernelRelease?.toLowerCase().includes("microsoft")) {
    return "linux";
  }
  return machineKindFromDmi({ chassisType, sysVendor, productName });
});

// One PowerShell call reads the enclosure and the system fields together.
// CIM is what Windows exposes SMBIOS through; there is no /sys equivalent.
const WINDOWS_PROBE_SCRIPT = [
  "$e = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1",
  "$s = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1",
  "[pscustomobject]@{ chassisTypes = @($e.ChassisTypes); manufacturer = $s.Manufacturer; model = $s.Model } | ConvertTo-Json -Compress",
].join("; ");

const detectWindowsMachineKind = Effect.fn("detectWindowsMachineKind")(function* () {
  const output = yield* runProbe({
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT],
    // Boot waits on this, and PowerShell is the slow probe. The terminal's CIM
    // probe budgets the same, and a miss draws a server.
    timeout: "1500 millis",
  });
  if (output === null) return null;
  const decoded = decodeWindowsProbe(output);
  return decoded === null ? null : machineKindFromWindowsComputerSystem(decoded);
});

// A missing enclosure serializes as `[null]`; keep the vendor fields usable.
const WindowsProbeOutput = Schema.Struct({
  chassisTypes: Schema.Array(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  manufacturer: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
});
const decodeWindowsProbeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(WindowsProbeOutput),
);

/** The probe's JSON as strings the chassis table can index; null when the output is not the probe's. */
function decodeWindowsProbe(output: string): {
  readonly chassisTypes: ReadonlyArray<string>;
  readonly manufacturer: string | null;
  readonly model: string | null;
} | null {
  const decoded = decodeWindowsProbeJson(output);
  if (Option.isNone(decoded)) return null;
  return {
    chassisTypes: decoded.value.chassisTypes.flatMap((value) =>
      value === null ? [] : [String(value)],
    ),
    manufacturer: normalize(decoded.value.manufacturer),
    model: normalize(decoded.value.model),
  };
}

export const detectServerEnvironmentMachineKind = Effect.fn("detectServerEnvironmentMachineKind")(
  function* () {
    const platform = yield* HostProcessPlatform;
    switch (platform) {
      case "darwin":
        return yield* detectDarwinMachineKind();
      case "linux":
        return yield* detectLinuxMachineKind();
      case "win32":
        return yield* detectWindowsMachineKind();
      default:
        return null;
    }
  },
);
