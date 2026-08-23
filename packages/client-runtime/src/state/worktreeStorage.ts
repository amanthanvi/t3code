import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export * from "./worktreeStorageDomain.ts";

export function createWorktreeStorageAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const report = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:worktree-storage:report",
    tag: WS_METHODS.worktreeStorageGetReport,
    staleTimeMs: 15_000,
  });
  const scheduler = createAtomCommandScheduler();
  const pruneStale = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:worktree-storage:prune-stale",
    tag: WS_METHODS.worktreeStoragePruneStale,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }) => environmentId,
    },
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(report({ environmentId, input: {} }))),
  });

  return { report, pruneStale };
}
