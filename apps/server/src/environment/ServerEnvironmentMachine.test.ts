import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  detectServerEnvironmentMachineKind,
  isContainerCgroup,
  machineKindFromAppleProductName,
  machineKindFromDmi,
  machineKindFromWindowsComputerSystem,
} from "./ServerEnvironmentMachine.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({ run: (input) => runMock(input) }),
);

const processOutput = (stdout: string, code = 0) =>
  Effect.succeed({
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

const dmiFileSystem = (
  files: Readonly<Record<string, string>>,
  existing: ReadonlyArray<string> = [],
) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(existing.includes(path)),
    readFileString: (path) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      return name in files
        ? Effect.succeed(files[name]!)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
              cause: new Error("ENOENT"),
            }),
          );
    },
  });

const withPlatform = (platform: NodeJS.Platform, fileSystem = FileSystem.layerNoop({})) =>
  Layer.mergeAll(ProcessRunnerTest, fileSystem, Layer.succeed(HostProcessPlatform, platform));

afterEach(() => {
  runMock.mockReset();
});

describe("machineKindFromAppleProductName", () => {
  it("maps marketing names and model identifiers", () => {
    expect(machineKindFromAppleProductName("Mac mini (2024)")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("Macmini8,1")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("Mac Studio (2023)")).toBe("mac-studio");
    expect(machineKindFromAppleProductName("MacBook Pro (14-inch, 2024)")).toBe("laptop");
    expect(machineKindFromAppleProductName("MacBookAir10,1")).toBe("laptop");
    expect(machineKindFromAppleProductName("iMac (24-inch, 2024)")).toBe("desktop");
    expect(machineKindFromAppleProductName("Mac Pro (2023)")).toBe("desktop");
  });

  it("looks up Apple silicon model identifiers, which carry no product family", () => {
    expect(machineKindFromAppleProductName("Mac16,10")).toBe("mac-mini");
    expect(machineKindFromAppleProductName("Mac14,13")).toBe("mac-studio");
    expect(machineKindFromAppleProductName("Mac15,3")).toBe("laptop");
    expect(machineKindFromAppleProductName("Mac16,2")).toBe("desktop");
    expect(machineKindFromAppleProductName("Mac99,1")).toBeNull();
  });
});

describe("machineKindFromDmi", () => {
  it("prefers virtualization markers over chassis type", () => {
    expect(
      machineKindFromDmi({ chassisType: "1", sysVendor: "QEMU", productName: "Standard PC" }),
    ).toBe("cloud");
    expect(
      machineKindFromDmi({
        chassisType: "3",
        sysVendor: "Microsoft Corporation",
        productName: "Virtual Machine",
      }),
    ).toBe("cloud");
    expect(
      machineKindFromDmi({ chassisType: "1", sysVendor: "Amazon EC2", productName: "t3.large" }),
    ).toBe("cloud");
  });

  it("does not treat Microsoft hardware as a VM", () => {
    expect(
      machineKindFromDmi({
        chassisType: "9",
        sysVendor: "Microsoft Corporation",
        productName: "Surface Laptop 5",
      }),
    ).toBe("laptop");
  });

  it("maps SMBIOS chassis codes", () => {
    expect(
      machineKindFromDmi({ chassisType: "3", sysVendor: "GMKtec", productName: "NucBox K8 Plus" }),
    ).toBe("desktop");
    expect(
      machineKindFromDmi({ chassisType: "10", sysVendor: "LENOVO", productName: "ThinkPad X1" }),
    ).toBe("laptop");
    expect(
      machineKindFromDmi({ chassisType: "23", sysVendor: "Supermicro", productName: "X11" }),
    ).toBe("server");
    expect(machineKindFromDmi({ chassisType: "1", sysVendor: null, productName: null })).toBeNull();
    expect(
      machineKindFromDmi({ chassisType: null, sysVendor: null, productName: null }),
    ).toBeNull();
  });

  it("recognizes Apple hardware running Linux", () => {
    expect(
      machineKindFromDmi({ chassisType: "3", sysVendor: "Apple", productName: "Mac Studio" }),
    ).toBe("mac-studio");
  });
});

describe("machineKindFromWindowsComputerSystem", () => {
  it("prefers virtualization markers, then the first mapped enclosure type", () => {
    expect(
      machineKindFromWindowsComputerSystem({
        chassisTypes: ["3"],
        manufacturer: "Microsoft Corporation",
        model: "Virtual Machine",
      }),
    ).toBe("cloud");
    expect(
      machineKindFromWindowsComputerSystem({
        chassisTypes: ["10"],
        manufacturer: "LENOVO",
        model: "ThinkPad X1",
      }),
    ).toBe("laptop");
    // Some firmware lists an unmapped shape first; the mapped one still counts.
    expect(
      machineKindFromWindowsComputerSystem({
        chassisTypes: ["1", "23"],
        manufacturer: "Dell",
        model: "PowerEdge",
      }),
    ).toBe("server");
    expect(
      machineKindFromWindowsComputerSystem({ chassisTypes: [], manufacturer: null, model: null }),
    ).toBeNull();
  });
});

describe("isContainerCgroup", () => {
  it("recognizes the runtimes that name themselves in PID 1's cgroup", () => {
    expect(isContainerCgroup("0::/system.slice/docker-abc123.scope\n")).toBe(true);
    expect(isContainerCgroup("0::/kubepods/besteffort/pod1/abc\n")).toBe(true);
    expect(isContainerCgroup("0::/lxc/web\n")).toBe(true);
    // cgroup v2 with a private namespace reports only the root; no host PID 1 does.
    expect(isContainerCgroup("0::/\n")).toBe(true);
    expect(isContainerCgroup("0::/init.scope\n")).toBe(false);
    expect(isContainerCgroup("0::/user.slice/user-1000.slice/session-2.scope\n")).toBe(false);
  });
});

describe("detectServerEnvironmentMachineKind", () => {
  it.effect("reads the IOKit product name on macOS", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        processOutput(
          '+-o product  <class IOPlatformDevice>\n    {\n      "product-name" = <"Mac mini (2024)">\n    }\n',
        ),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("darwin")),
      );

      expect(result).toBe("mac-mini");
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "ioreg", args: ["-rd1", "-n", "product"] }),
      );
    }),
  );

  it.effect("falls back to hw.model when IOKit has no product node", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(processOutput("", 1));
      runMock.mockReturnValueOnce(processOutput("MacBookPro16,1\n"));

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("darwin")),
      );

      expect(result).toBe("laptop");
      expect(runMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "sysctl", args: ["-n", "hw.model"] }),
      );
    }),
  );

  it.effect("returns null when both macOS probes fail", () =>
    Effect.gen(function* () {
      runMock.mockImplementation((input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        ),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("darwin")),
      );

      expect(result).toBeNull();
      expect(runMock).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("reads DMI on Linux", () =>
    Effect.gen(function* () {
      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(
          withPlatform(
            "linux",
            dmiFileSystem({
              chassis_type: "3\n",
              sys_vendor: "GMKtec\n",
              product_name: "NucBox K8 Plus\n",
            }),
          ),
        ),
      );

      expect(result).toBe("desktop");
      expect(runMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("recognizes WSL before its Hyper-V DMI identity", () =>
    Effect.gen(function* () {
      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(
          withPlatform(
            "linux",
            dmiFileSystem({
              osrelease: "5.15.153.1-microsoft-standard-WSL2\n",
              chassis_type: "3\n",
              sys_vendor: "Microsoft Corporation\n",
              product_name: "Virtual Machine\n",
            }),
          ),
        ),
      );

      expect(result).toBe("linux");
    }),
  );

  it.effect("returns null on Linux without DMI (ARM boards)", () =>
    Effect.gen(function* () {
      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("linux", dmiFileSystem({}))),
      );

      expect(result).toBeNull();
    }),
  );

  it.effect("recognizes a container by its runtime marker before the host's DMI", () =>
    Effect.gen(function* () {
      const inDocker = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(
          withPlatform(
            "linux",
            dmiFileSystem(
              { chassis_type: "23\n", sys_vendor: "Supermicro\n", product_name: "X11\n" },
              ["/.dockerenv"],
            ),
          ),
        ),
      );
      expect(inDocker).toBe("container");

      const inKubernetes = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(
          withPlatform("linux", dmiFileSystem({ cgroup: "0::/kubepods/burstable/pod1/abc\n" })),
        ),
      );
      expect(inKubernetes).toBe("container");

      // A Docker Desktop container runs on the WSL 2 kernel; the marker wins.
      const onDockerDesktop = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(
          withPlatform(
            "linux",
            dmiFileSystem({ osrelease: "5.15.153.1-microsoft-standard-WSL2\n" }, ["/.dockerenv"]),
          ),
        ),
      );
      expect(onDockerDesktop).toBe("container");
      expect(runMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads the SMBIOS enclosure through PowerShell on Windows", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        processOutput('{"chassisTypes":[10],"manufacturer":"LENOVO","model":"ThinkPad X1"}\n'),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("win32")),
      );

      expect(result).toBe("laptop");
      expect(runMock).toHaveBeenCalledTimes(1);
      const call = runMock.mock.calls[0]?.[0];
      expect(call?.command).toBe("powershell.exe");
      expect(call?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
      // The script must wrap the enclosure list, or a single type unwraps to a scalar.
      expect(call?.args[3]).toContain("@($e.ChassisTypes)");
      expect(call?.args[3]).toContain("ConvertTo-Json -Compress");
    }),
  );

  it.effect("keeps the Windows vendor fields when the enclosure is missing", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        processOutput(
          '{"chassisTypes":[null],"manufacturer":"Microsoft Corporation","model":"Virtual Machine"}\n',
        ),
      );

      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("win32")),
      );

      expect(result).toBe("cloud");
    }),
  );

  it.effect("returns null when the Windows probe fails or prints something else", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(processOutput("", 1));
      expect(
        yield* detectServerEnvironmentMachineKind().pipe(Effect.provide(withPlatform("win32"))),
      ).toBeNull();

      runMock.mockReturnValueOnce(processOutput("Access is denied.\n"));
      expect(
        yield* detectServerEnvironmentMachineKind().pipe(Effect.provide(withPlatform("win32"))),
      ).toBeNull();
    }),
  );

  it.effect("skips detection on platforms with no probe", () =>
    Effect.gen(function* () {
      const result = yield* detectServerEnvironmentMachineKind().pipe(
        Effect.provide(withPlatform("freebsd")),
      );

      expect(result).toBeNull();
      expect(runMock).not.toHaveBeenCalled();
    }),
  );
});
