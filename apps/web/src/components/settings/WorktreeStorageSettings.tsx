import {
  WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS,
  WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS,
  type EnvironmentId,
  type WorktreeAutoPrunePolicy,
  type WorktreeStorageDetail,
  type WorktreeStorageProjectAggregate,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  formatWorktreeStorageBytes,
  planAcrossEnvironmentPrune,
  rankWorktreeEntries,
  rankWorktreeProjects,
  resolveFrozenPrunePlan,
  skippedPruneOutcome,
  successfulPruneOutcome,
  summarizePruneOutcomes,
  worktreeDisplayName,
  type EnvironmentPruneOutcome,
} from "@t3tools/client-runtime/state/worktree-storage";
import { HardDriveIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment, worktreeStorageEnvironment } from "../../state/server";
import {
  useWorktreeStorage,
  type EnvironmentWorktreeStorageStatus,
} from "../../state/worktree-storage";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { describeWorktreeProtectionReason } from "../../worktreeStorage.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PROJECT_DISPLAY_LIMIT = 8;
const WORKTREE_DISPLAY_LIMIT_PER_PROJECT = 4;
const DEFAULT_INACTIVITY_DAYS = 30;

interface FrozenEnvironmentRef {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface PruneScope {
  readonly type: "environment" | "across";
  readonly targets: readonly FrozenEnvironmentRef[];
  readonly skipped: readonly EnvironmentPruneOutcome[];
}

function environmentStatusLabel(environment: EnvironmentWorktreeStorageStatus): string {
  switch (environment.state) {
    case "ready":
      return environment.isRefreshing ? "Refreshing…" : "Reported";
    case "loading":
      return environment.connectionPhase === "connected" ? "Scanning…" : "Connecting…";
    case "offline":
      return "Offline";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Unavailable";
  }
}

function environmentDescription(environment: EnvironmentWorktreeStorageStatus): string {
  if (environment.report) {
    const freshness = formatRelativeTimeLabel(environment.report.scannedAt);
    const partial = environment.report.partial ? " · Partial scan" : "";
    return `${environment.report.worktreeCount} worktrees · Scanned ${freshness || "recently"}${partial}`;
  }
  switch (environment.state) {
    case "offline":
      return "Offline. Its storage is unknown and is not counted as zero.";
    case "unsupported":
      return "This server version does not support worktree storage management.";
    case "error":
      return environment.error ?? "This system could not report worktree storage.";
    case "loading":
      return environment.connectionPhase === "connected"
        ? "Scanning worktree storage on this system…"
        : "Waiting for this system to connect.";
    case "ready":
      return "Worktree storage reported.";
  }
}

function policyLabel(policy: WorktreeAutoPrunePolicy): string {
  switch (policy.mode) {
    case "off":
      return "Off";
    case "on-settle":
      return "When threads settle";
    case "after-inactive-days":
      return `After ${policy.inactivityDays} inactive ${policy.inactivityDays === 1 ? "day" : "days"}`;
  }
}

function EnvironmentPolicyControl({
  environment,
  disabled,
  onUpdate,
}: {
  readonly environment: EnvironmentWorktreeStorageStatus;
  readonly disabled: boolean;
  readonly onUpdate: (environmentId: EnvironmentId, policy: WorktreeAutoPrunePolicy) => void;
}) {
  const policy = environment.policy;
  const policyDays =
    policy.mode === "after-inactive-days" ? policy.inactivityDays : DEFAULT_INACTIVITY_DAYS;
  const [draftMode, setDraftMode] = useState<WorktreeAutoPrunePolicy["mode"]>(policy.mode);
  const [draftDays, setDraftDays] = useState(String(policyDays));
  useEffect(() => {
    setDraftMode(policy.mode);
    setDraftDays(String(policyDays));
  }, [policy.mode, policyDays]);

  const days = Number(draftDays);
  const daysValid =
    Number.isInteger(days) &&
    days >= WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS &&
    days <= WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS;
  const draftPolicy: WorktreeAutoPrunePolicy | null =
    draftMode === "after-inactive-days"
      ? daysValid
        ? { mode: draftMode, inactivityDays: days }
        : null
      : { mode: draftMode };
  const hasChanges =
    draftPolicy !== null &&
    (draftPolicy.mode !== policy.mode ||
      (draftPolicy.mode === "after-inactive-days" &&
        policy.mode === "after-inactive-days" &&
        draftPolicy.inactivityDays !== policy.inactivityDays));

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
      <Select
        disabled={disabled}
        value={draftMode}
        onValueChange={(value) => {
          if (value === "off" || value === "on-settle" || value === "after-inactive-days") {
            setDraftMode(value);
          }
        }}
      >
        <SelectTrigger
          aria-label={`Automatic prune policy for ${environment.label}`}
          className="w-full sm:w-48"
        >
          <SelectValue>
            {draftPolicy === null ? "After inactivity" : policyLabel(draftPolicy)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="on-settle">When threads settle</SelectItem>
          <SelectItem value="after-inactive-days">After inactivity</SelectItem>
        </SelectPopup>
      </Select>
      {draftMode === "after-inactive-days" ? (
        <div className="flex min-w-0 items-center gap-2 sm:w-40">
          <Input
            nativeInput
            type="number"
            min={WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS}
            max={WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS}
            value={draftDays}
            disabled={disabled}
            onChange={(event) => setDraftDays(event.currentTarget.value)}
            aria-label={`Inactivity days for ${environment.label}`}
            aria-invalid={!daysValid}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 text-xs text-muted-foreground">days</span>
        </div>
      ) : null}
      <Button
        size="sm"
        disabled={disabled || draftPolicy === null || !hasChanges}
        onClick={() => draftPolicy && onUpdate(environment.environmentId, draftPolicy)}
      >
        Apply
      </Button>
    </div>
  );
}

function WorktreeDetailRow({ detail }: { readonly detail: WorktreeStorageDetail }) {
  const reasons = detail.protectionReasons.map(describeWorktreeProtectionReason);
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {worktreeDisplayName(detail.worktreePath)}
          </span>
          <Badge size="sm" variant={detail.eligible ? "success" : "secondary"}>
            {detail.eligible ? "Eligible for stale pruning" : "Protected"}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {reasons.length > 0
            ? reasons.join(" · ")
            : detail.eligible
              ? "Stale and cleared by server safety checks"
              : "Protected by server safety checks"}
          {detail.latestActivityAt
            ? ` · Active ${formatRelativeTimeLabel(detail.latestActivityAt)}`
            : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatWorktreeStorageBytes(detail.bytes)}
      </span>
    </li>
  );
}

function ProjectStorageDetails({
  project,
  details,
  rank,
}: {
  readonly project: Pick<
    WorktreeStorageProjectAggregate,
    "projectTitle" | "bytes" | "worktreeCount" | "eligibleWorktreeCount" | "staleWorktreeCount"
  >;
  readonly details: readonly WorktreeStorageDetail[];
  readonly rank: number | null;
}) {
  const rankedDetails = rankWorktreeEntries(details).slice(0, WORKTREE_DISPLAY_LIMIT_PER_PROJECT);
  return (
    <li className="border-t border-border/60 py-3 first:border-t-0">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {rank === null ? null : (
              <span className="me-2 text-muted-foreground tabular-nums">{rank}.</span>
            )}
            {project.projectTitle}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {project.worktreeCount} worktrees · {project.eligibleWorktreeCount} eligible ·{" "}
            {project.staleWorktreeCount} stale
          </p>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
          {formatWorktreeStorageBytes(project.bytes)}
        </span>
      </div>
      {rankedDetails.length > 0 ? (
        <ul className="mt-2 ms-6 border-s border-border/60 ps-3">
          {rankedDetails.map((detail) => (
            <WorktreeDetailRow key={detail.worktreePath} detail={detail} />
          ))}
        </ul>
      ) : null}
      {details.length > rankedDetails.length ? (
        <p className="mt-1 ms-6 text-[11px] text-muted-foreground">
          Showing {rankedDetails.length} of {details.length} worktrees for this project.
        </p>
      ) : null}
    </li>
  );
}

function EnvironmentInventory({
  environment,
}: {
  readonly environment: EnvironmentWorktreeStorageStatus;
}) {
  const report = environment.report;
  if (!report) return null;
  const projects = rankWorktreeProjects(report.projects).slice(0, PROJECT_DISPLAY_LIMIT);
  const unassignedDetails = rankWorktreeEntries(
    report.details.filter((detail) => detail.projectId === null),
  );
  const unassignedBytes = unassignedDetails.reduce((sum, detail) => sum + detail.bytes, 0);

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      {report.partial || report.errors.length > 0 ? (
        <p className="mb-3 rounded-lg bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          This scan is partial. Unreadable or unknown storage remains protected and may not be in
          the total.
        </p>
      ) : null}
      {projects.length > 0 ? (
        <ol aria-label={`Projects on ${environment.label}`}>
          {projects.map((project, index) => (
            <ProjectStorageDetails
              key={project.projectId}
              project={project}
              rank={index + 1}
              details={report.details.filter((detail) => detail.projectId === project.projectId)}
            />
          ))}
        </ol>
      ) : unassignedDetails.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">No managed worktrees were found.</p>
      ) : null}
      {unassignedDetails.length > 0 ? (
        <div className="mt-2 rounded-lg border border-border/60 px-3">
          <p className="pt-3 text-[11px] leading-relaxed text-muted-foreground">
            These managed worktrees are no longer linked to a registered project. They are always
            protected from manual and automatic bulk pruning. The size shown is the sum of reported
            unassigned details.
          </p>
          <ul aria-label={`Unassigned managed worktrees on ${environment.label}`}>
            <ProjectStorageDetails
              project={{
                projectTitle: "Unassigned managed worktrees",
                bytes: unassignedBytes,
                worktreeCount: unassignedDetails.length,
                eligibleWorktreeCount: unassignedDetails.filter((detail) => detail.eligible).length,
                staleWorktreeCount: unassignedDetails.filter((detail) => detail.stale).length,
              }}
              rank={null}
              details={unassignedDetails}
            />
          </ul>
        </div>
      ) : null}
      {report.projects.length > projects.length || report.projectCount > report.projects.length ? (
        <p className="pt-2 text-xs text-muted-foreground">
          Showing {projects.length} of {report.projectCount} projects, ranked by known bytes.
        </p>
      ) : null}
    </div>
  );
}

function pruneSummaryDescription(outcomes: readonly EnvironmentPruneOutcome[]): string {
  const summary = summarizePruneOutcomes(outcomes);
  const parts = [
    `${summary.removedCount} removed`,
    `${summary.protectedCount} protected`,
    `${summary.failedWorktreeCount} worktree failures`,
    `${summary.partialEnvironmentCount} partial systems`,
    `${summary.serverErrorCount} server errors`,
    `${summary.unreportedOutcomeCount} outcome details omitted`,
    `${summary.skippedEnvironmentCount} systems skipped`,
    `${summary.failedEnvironmentCount} systems failed`,
  ];
  return `${formatWorktreeStorageBytes(summary.freedBytes)} estimated reclaimed · ${parts.join(" · ")}`;
}

export function WorktreeStorageSettings() {
  const { environments, coverage, refresh } = useWorktreeStorage();
  const pruneStale = useAtomCommand(worktreeStorageEnvironment.pruneStale, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [pruneScope, setPruneScope] = useState<PruneScope | null>(null);
  const [isPruning, setIsPruning] = useState(false);
  const [savingPolicyEnvironmentId, setSavingPolicyEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [lastOutcomes, setLastOutcomes] = useState<readonly EnvironmentPruneOutcome[]>([]);
  const mutationPending = useRef(false);
  const plan = useMemo(() => planAcrossEnvironmentPrune(environments), [environments]);

  const updatePolicy = async (environmentId: EnvironmentId, policy: WorktreeAutoPrunePolicy) => {
    setSavingPolicyEnvironmentId(environmentId);
    const result = await updateSettings({
      environmentId,
      input: { patch: { worktreeAutoPrunePolicy: policy } },
    });
    setSavingPolicyEnvironmentId(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Automatic prune policy updated" });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update automatic prune policy",
        description:
          error instanceof Error ? error.message : "Try again when this system is connected.",
      });
    }
  };

  const openPruneConfirmation = (type: PruneScope["type"], environmentId?: EnvironmentId) => {
    const candidates =
      environmentId === undefined
        ? environments
        : environments.filter((environment) => environment.environmentId === environmentId);
    const frozenPlan = planAcrossEnvironmentPrune(candidates);
    setPruneScope({
      type,
      targets: frozenPlan.targets.map(({ environmentId: id, label }) => ({
        environmentId: id,
        label,
      })),
      skipped: frozenPlan.skipped.map(skippedPruneOutcome),
    });
  };

  const runPrune = async () => {
    if (pruneScope === null || mutationPending.current) return;
    mutationPending.current = true;
    setIsPruning(true);

    const confirmedIds = pruneScope.targets.map((environment) => environment.environmentId);
    const currentPlan = resolveFrozenPrunePlan(environments, confirmedIds);
    const targets = currentPlan.targets;
    const currentIds = new Set(environments.map((environment) => environment.environmentId));
    const skipped = [
      ...pruneScope.skipped,
      ...currentPlan.skipped.map(skippedPruneOutcome),
      ...pruneScope.targets
        .filter((environment) => !currentIds.has(environment.environmentId))
        .map(
          (environment): EnvironmentPruneOutcome => ({
            ...environment,
            status: "skipped",
            reason: "unavailable",
          }),
        ),
    ];
    const results = await Promise.all(
      targets.map(async (environment): Promise<EnvironmentPruneOutcome> => {
        const result = await pruneStale({ environmentId: environment.environmentId, input: {} });
        if (result._tag === "Success") {
          return successfulPruneOutcome(environment, result.value);
        }
        const cause = squashAtomCommandFailure(result);
        return {
          environmentId: environment.environmentId,
          label: environment.label,
          status: "failure",
          error: cause instanceof Error ? cause.message : "Prune request failed.",
        };
      }),
    );
    const outcomes = [...results, ...skipped];
    const summary = summarizePruneOutcomes(outcomes);
    setLastOutcomes(outcomes);
    toastManager.add({
      type: summary.tone,
      title:
        summary.tone === "warning"
          ? "Prune finished with exceptions"
          : summary.tone === "error"
            ? "Prune failed"
            : summary.removedCount > 0
              ? `Pruned ${summary.removedCount} stale ${summary.removedCount === 1 ? "worktree" : "worktrees"}`
              : "No stale worktrees were pruned",
      description: pruneSummaryDescription(outcomes),
    });
    setPruneScope(null);
    setIsPruning(false);
    mutationPending.current = false;
  };

  const confirmTargets = pruneScope?.targets ?? [];
  const confirmSkipped = pruneScope?.skipped ?? [];
  const canRefresh = environments.some(
    (environment) => environment.connectionPhase === "connected" && environment.capable,
  );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        {...searchableSetting("worktree-storage-overview")}
        icon={<HardDriveIcon className="size-4.5 text-muted-foreground" />}
        headerAction={
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!canRefresh}
            onClick={refresh}
            aria-label="Refresh worktree storage"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Known worktree space"
          description={
            coverage.environmentCount === 0
              ? "No systems are configured."
              : coverage.complete
                ? `Reported by all ${coverage.environmentCount} systems.`
                : `Known reports from ${coverage.knownEnvironmentCount} of ${coverage.environmentCount} systems.${coverage.partialCount > 0 ? ` ${coverage.partialCount} ${coverage.partialCount === 1 ? "report is" : "reports are"} partial.` : ""} Missing or unknown storage is not counted as zero.`
          }
          status={
            coverage.complete
              ? "Known checkout bytes; shared Git object storage is excluded."
              : `${coverage.offlineCount} offline · ${coverage.unsupportedCount} unsupported · ${coverage.errorCount} failed · ${coverage.loadingCount} pending · ${coverage.partialCount} partial · Shared Git object storage is excluded.`
          }
          control={
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {coverage.knownEnvironmentCount > 0
                ? formatWorktreeStorageBytes(coverage.totalKnownBytes)
                : "Unknown"}
            </span>
          }
        />
      </SettingsSection>

      <SettingsSection title="Systems">
        {environments.length > 0 ? (
          environments.map((environment) => (
            <SettingsRow
              key={environment.environmentId}
              title={environment.label}
              description={environmentDescription(environment)}
              status={environmentStatusLabel(environment)}
              control={
                environment.report ? (
                  <span className="font-medium tabular-nums text-foreground">
                    {formatWorktreeStorageBytes(environment.report.totalBytes)}
                  </span>
                ) : (
                  <Badge
                    variant={
                      environment.state === "error"
                        ? "error"
                        : environment.state === "unsupported"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {environmentStatusLabel(environment)}
                  </Badge>
                )
              }
            >
              <EnvironmentInventory environment={environment} />
              <div className="mt-3 grid gap-3 border-t border-border/60 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,auto)] lg:items-center">
                <div>
                  <p className="text-xs font-medium text-foreground">Automatic pruning</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    This policy belongs to {environment.label}. Protected worktrees are never
                    removed just because a policy is enabled.
                  </p>
                </div>
                <EnvironmentPolicyControl
                  environment={environment}
                  disabled={
                    environment.connectionPhase !== "connected" ||
                    !environment.capable ||
                    savingPolicyEnvironmentId === environment.environmentId
                  }
                  onUpdate={(environmentId, policy) => void updatePolicy(environmentId, policy)}
                />
              </div>
              <div className="flex justify-end border-t border-border/60 py-3">
                <Button
                  variant="destructive-outline"
                  disabled={
                    isPruning || environment.connectionPhase !== "connected" || !environment.capable
                  }
                  onClick={() => openPruneConfirmation("environment", environment.environmentId)}
                >
                  <Trash2Icon />
                  Prune all stale worktrees on this system
                </Button>
              </div>
            </SettingsRow>
          ))
        ) : (
          <SettingsRow
            title="No systems"
            description="Add an environment to report worktree storage."
          />
        )}
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("worktree-pruning")}
        icon={<ShieldCheckIcon className="size-4.5 text-muted-foreground" />}
      >
        <SettingsRow
          title="Prune across connected systems"
          description="Requests a fresh server-side prune from each system that is connected and supports this feature. Offline systems are skipped and never queued for reconnect."
          control={
            <Button
              variant="destructive-outline"
              disabled={isPruning || plan.targets.length === 0}
              onClick={() => openPruneConfirmation("across")}
            >
              <Trash2Icon />
              Prune all stale worktrees across connected systems
            </Button>
          }
          status={
            plan.skipped.length > 0
              ? `${plan.targets.length} connected and capable · ${plan.skipped.length} will be skipped`
              : `${plan.targets.length} connected and capable`
          }
        />
        {lastOutcomes.length > 0 ? (
          <div
            className="rounded-xl px-3 py-3 text-xs text-muted-foreground sm:px-4"
            aria-live="polite"
          >
            <p className="font-medium text-foreground">Last prune request</p>
            <p className="mt-1">{pruneSummaryDescription(lastOutcomes)}</p>
            <ul className="mt-2 space-y-1">
              {lastOutcomes.map((outcome) => (
                <li key={outcome.environmentId}>
                  {outcome.label}:{" "}
                  {outcome.status === "success"
                    ? `${outcome.removedCount} removed, ${outcome.skippedCount} protected, ${outcome.failedCount} failed${outcome.partial ? ", partial result" : ""}${outcome.serverErrorCount > 0 ? `, ${outcome.serverErrorCount} server errors` : ""}${outcome.unreportedOutcomeCount > 0 ? `, ${outcome.unreportedOutcomeCount} outcome details omitted` : ""}`
                    : outcome.status === "skipped"
                      ? `Skipped (${outcome.reason})`
                      : `Failed (${outcome.error})`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsSection>

      <AlertDialog
        open={pruneScope !== null}
        onOpenChange={(open) => !open && !isPruning && setPruneScope(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pruneScope?.type === "environment"
                ? `Prune all stale worktrees on ${confirmTargets[0]?.label ?? "this system"}?`
                : `Prune all stale worktrees across ${confirmTargets.length} connected ${confirmTargets.length === 1 ? "system" : "systems"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-left">
              <span className="block">
                Each listed system performs a fresh safety check. Dirty, active, or unknown
                worktrees remain protected. T3 Code never queues this action for an offline system.
              </span>
              {confirmTargets.length > 0 ? (
                <span className="block">
                  <span className="font-medium text-foreground">Included:</span>{" "}
                  {confirmTargets.map((environment) => environment.label).join(", ")}
                </span>
              ) : null}
              {confirmSkipped.length > 0 ? (
                <span className="block">
                  <span className="font-medium text-foreground">Skipped:</span>{" "}
                  {confirmSkipped.map((environment) => environment.label).join(", ")}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isPruning} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isPruning || confirmTargets.length === 0}
              onClick={() => void runPrune()}
            >
              {isPruning ? "Pruning…" : "Prune all stale worktrees"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
