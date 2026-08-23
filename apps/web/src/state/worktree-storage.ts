import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_WORKTREE_AUTO_PRUNE_POLICY,
  type EnvironmentId,
  type WorktreeAutoPrunePolicy,
  type WorktreeStorageReport,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import {
  computeWorktreeStorageCoverage,
  rankWorktreeEnvironments,
  type WorktreeStorageCoverage,
  type WorktreeStorageEnvironmentState,
  type WorktreeStorageEnvironmentSummary,
} from "@t3tools/client-runtime/state/worktree-storage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { worktreeStorageEnvironment } from "./server";

export interface EnvironmentWorktreeStorageStatus extends WorktreeStorageEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly report: WorktreeStorageReport | null;
  readonly policy: WorktreeAutoPrunePolicy;
  readonly isRefreshing: boolean;
  readonly error: string | null;
}

const worktreeStorageAtom = Atom.make((get): readonly EnvironmentWorktreeStorageStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentWorktreeStorageStatus[] = [];

  for (const [environmentId, presentation] of presentations) {
    const connectionPhase = presentation.connection.phase;
    const capable = presentation.serverConfig?.environment.capabilities.worktreeStorage === true;
    const policy =
      presentation.serverConfig?.settings.worktreeAutoPrunePolicy ??
      DEFAULT_WORKTREE_AUTO_PRUNE_POLICY;
    let state: WorktreeStorageEnvironmentState;
    let report: WorktreeStorageReport | null = null;
    let isRefreshing = false;
    let error: string | null = null;

    if (connectionPhase !== "connected") {
      state =
        connectionPhase === "error"
          ? "error"
          : connectionPhase === "offline"
            ? "offline"
            : "loading";
      error =
        connectionPhase === "error"
          ? (presentation.connection.error ?? "This system could not be reached.")
          : null;
    } else if (presentation.serverConfig === null) {
      state = "loading";
    } else if (!capable) {
      state = "unsupported";
    } else {
      const result = get(worktreeStorageEnvironment.report({ environmentId, input: {} }));
      report = Option.getOrNull(AsyncResult.value(result));
      isRefreshing = result.waiting && report !== null;
      if (result._tag === "Failure") {
        state = "error";
        error = "This system could not report worktree storage.";
      } else {
        state = report === null ? "loading" : "ready";
      }
    }

    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      connectionPhase,
      capable,
      state,
      totalBytes: report?.totalBytes ?? null,
      partial: report?.partial ?? false,
      report,
      policy,
      isRefreshing,
      error,
    });
  }

  return statuses;
}).pipe(Atom.withLabel("web-worktree-storage"));

export interface WorktreeStorageView {
  readonly environments: readonly EnvironmentWorktreeStorageStatus[];
  readonly coverage: WorktreeStorageCoverage;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useWorktreeStorage(): WorktreeStorageView {
  const rawEnvironments = useAtomValue(worktreeStorageAtom);
  const environments = useMemo(() => rankWorktreeEnvironments(rawEnvironments), [rawEnvironments]);
  const coverage = useMemo(() => computeWorktreeStorageCoverage(environments), [environments]);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      if (environment.connectionPhase !== "connected" || !environment.capable) continue;
      appAtomRegistry.refresh(
        worktreeStorageEnvironment.report({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  return {
    environments,
    coverage,
    isPending: environments.every((environment) => environment.state === "loading"),
    refresh,
  };
}
