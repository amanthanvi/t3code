import { useNavigation } from "@react-navigation/native";
import {
  WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS,
  WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS,
  type EnvironmentId,
  type WorktreeAutoPrunePolicy,
  type WorktreeStorageDetail,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  computeWorktreeStorageCoverage,
  formatWorktreeStorageBytes,
  planAcrossEnvironmentPrune,
  rankWorktreeEntries,
  rankWorktreeProjects,
  resolveFrozenPrunePlan,
  successfulPruneOutcome,
  summarizePruneOutcomes,
  worktreeDisplayName,
  worktreeStorageSkippedReason,
  type EnvironmentPruneOutcome,
  type WorktreeStorageSkippedReason,
} from "@t3tools/client-runtime/state/worktree-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment, worktreeStorageEnvironment } from "../../state/server";
import {
  useMobileWorktreeStorage,
  type MobileEnvironmentWorktreeStorageStatus,
} from "../../state/worktree-storage";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import {
  mobileProtectionLabel,
  summarizeMobilePrune,
  updatePendingEnvironmentIds,
} from "./SettingsWorktreeStorage.logic";

const PROJECT_LIMIT = 6;
const WORKTREE_LIMIT_PER_PROJECT = 3;
const DEFAULT_INACTIVITY_DAYS = 30;

interface FrozenMobileEnvironmentRef {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface FrozenMobileSkippedEnvironment extends FrozenMobileEnvironmentRef {
  readonly reason: WorktreeStorageSkippedReason;
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

function statusLabel(environment: MobileEnvironmentWorktreeStorageStatus): string {
  switch (environment.state) {
    case "ready":
      return environment.isRefreshing ? "Refreshing…" : "Reported";
    case "loading":
      return environment.connectionPhase === "connected" ? "Scanning…" : "Connecting…";
    case "offline":
      return "Offline · storage unknown";
    case "unsupported":
      return "Server update required";
    case "error":
      return environment.error ?? "Storage unavailable";
  }
}

function DetailRow({ detail }: { readonly detail: WorktreeStorageDetail }) {
  const reasons = detail.protectionReasons.map(mobileProtectionLabel);
  return (
    <View className="gap-1 border-t border-border-subtle py-3 first:border-t-0">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {worktreeDisplayName(detail.worktreePath)}
        </Text>
        <Text className="shrink-0 text-sm tabular-nums text-foreground-muted">
          {formatWorktreeStorageBytes(detail.bytes)}
        </Text>
      </View>
      <Text
        className={
          detail.eligible ? "text-xs text-success-foreground" : "text-xs text-foreground-muted"
        }
      >
        {detail.eligible
          ? "Eligible for stale pruning"
          : `Protected${reasons.length > 0 ? ` · ${reasons.join(" · ")}` : " by server safety checks"}`}
      </Text>
    </View>
  );
}

function PolicyControl(props: {
  readonly environment: MobileEnvironmentWorktreeStorageStatus;
  readonly disabled: boolean;
  readonly onUpdate: (environmentId: EnvironmentId, policy: WorktreeAutoPrunePolicy) => void;
}) {
  const chevronColor = useThemeColor("--color-chevron");
  const policy = props.environment.policy;
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
  const actions = [
    {
      id: "off",
      title: "Off",
      state: draftMode === "off" ? ("on" as const) : ("off" as const),
    },
    {
      id: "on-settle",
      title: "When threads settle",
      state: draftMode === "on-settle" ? ("on" as const) : ("off" as const),
    },
    {
      id: "after-inactive-days",
      title: "After inactivity",
      state: draftMode === "after-inactive-days" ? ("on" as const) : ("off" as const),
    },
  ];

  return (
    <View className="border-t border-border-subtle">
      <ControlPillMenu
        actions={props.disabled ? [] : actions}
        onPressAction={(event: { nativeEvent: { event: string } }) => {
          if (props.disabled) return;
          const mode = event.nativeEvent.event;
          if (mode === "off" || mode === "on-settle" || mode === "after-inactive-days") {
            setDraftMode(mode);
          }
        }}
      >
        <Pressable
          accessibilityLabel={`Automatic prune policy for ${props.environment.label}`}
          accessibilityRole="button"
          disabled={props.disabled}
          className="min-h-14 flex-row items-center gap-3 px-4 py-3 disabled:opacity-40"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-base text-foreground">Automatic pruning</Text>
            <Text className="mt-0.5 text-xs text-foreground-muted">
              {draftPolicy === null ? "After inactivity" : policyLabel(draftPolicy)}
            </Text>
          </View>
          <SymbolView
            name="chevron.up.chevron.down"
            size={14}
            tintColor={chevronColor}
            type="monochrome"
          />
        </Pressable>
      </ControlPillMenu>
      {draftMode === "after-inactive-days" ? (
        <View className="flex-row items-center gap-3 px-4 pb-4">
          <TextInput
            accessibilityLabel={`Inactivity days for ${props.environment.label}`}
            editable={!props.disabled}
            keyboardType="number-pad"
            value={draftDays}
            onChangeText={setDraftDays}
            className="min-w-0 flex-1 rounded-xl border border-input-border bg-input px-3 py-2 text-base text-foreground"
          />
          <Text className="shrink-0 text-sm text-foreground-muted">
            days ({WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS}–
            {WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS})
          </Text>
        </View>
      ) : null}
      <Pressable
        accessibilityLabel={`Apply automatic prune policy for ${props.environment.label}`}
        accessibilityRole="button"
        disabled={props.disabled || draftPolicy === null || !hasChanges}
        onPress={() => draftPolicy && props.onUpdate(props.environment.environmentId, draftPolicy)}
        className="min-h-12 items-center justify-center border-t border-border-subtle px-4 py-3 disabled:opacity-40"
      >
        <Text className="text-sm font-t3-medium text-foreground">Apply policy</Text>
      </Pressable>
    </View>
  );
}

function EnvironmentSection(props: {
  readonly environment: MobileEnvironmentWorktreeStorageStatus;
  readonly pruning: boolean;
  readonly savingPolicy: boolean;
  readonly onConfirmPrune: (environmentId: EnvironmentId) => void;
  readonly onUpdatePolicy: (environmentId: EnvironmentId, policy: WorktreeAutoPrunePolicy) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const report = props.environment.report;
  const projects = useMemo(
    () => rankWorktreeProjects(report?.projects ?? []).slice(0, PROJECT_LIMIT),
    [report?.projects],
  );
  const unassignedDetails = useMemo(
    () =>
      rankWorktreeEntries((report?.details ?? []).filter((detail) => detail.projectId === null)),
    [report?.details],
  );
  const visibleUnassignedDetails = unassignedDetails.slice(0, WORKTREE_LIMIT_PER_PROJECT);
  const unassignedBytes = unassignedDetails.reduce((sum, detail) => sum + detail.bytes, 0);
  const canManage = props.environment.connectionPhase === "connected" && props.environment.capable;

  return (
    <View className="gap-2">
      <SettingsSection title={props.environment.label}>
        <View className="flex-row items-start gap-3 p-4">
          <SymbolView name="externaldrive" size={22} tintColor={iconColor} type="monochrome" />
          <View className="min-w-0 flex-1">
            <Text className="text-lg text-foreground">
              {report ? formatWorktreeStorageBytes(report.totalBytes) : "Unknown"}
            </Text>
            <Text className="mt-0.5 text-sm leading-normal text-foreground-muted">
              {statusLabel(props.environment)}
              {report ? ` · ${report.worktreeCount} worktrees` : ""}
            </Text>
          </View>
          {props.environment.isRefreshing ? <ActivityIndicator /> : null}
        </View>

        {report?.partial || (report?.errors.length ?? 0) > 0 ? (
          <Text className="border-t border-border-subtle px-4 py-3 text-sm leading-normal text-foreground-muted">
            Partial scan. Unknown storage stays protected and may not be included in the total.
          </Text>
        ) : null}

        {projects.map((project, index) => {
          const details = rankWorktreeEntries(
            (report?.details ?? []).filter((detail) => detail.projectId === project.projectId),
          );
          const visibleDetails = details.slice(0, WORKTREE_LIMIT_PER_PROJECT);
          return (
            <View key={project.projectId} className="border-t border-border-subtle px-4 py-3">
              <View className="flex-row items-start justify-between gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {index + 1}. {project.projectTitle}
                  </Text>
                  <Text className="mt-0.5 text-xs text-foreground-muted">
                    {project.worktreeCount} worktrees · {project.eligibleWorktreeCount} eligible ·{" "}
                    {project.staleWorktreeCount} stale
                  </Text>
                </View>
                <Text className="shrink-0 text-base tabular-nums text-foreground">
                  {formatWorktreeStorageBytes(project.bytes)}
                </Text>
              </View>
              {visibleDetails.length > 0 ? (
                <View className="mt-2 ms-3 border-s border-border-subtle ps-3">
                  {visibleDetails.map((detail) => (
                    <DetailRow key={detail.worktreePath} detail={detail} />
                  ))}
                </View>
              ) : null}
              {details.length > visibleDetails.length ? (
                <Text className="mt-2 text-xs text-foreground-muted">
                  Showing {visibleDetails.length} of {details.length} worktrees.
                </Text>
              ) : null}
            </View>
          );
        })}

        {unassignedDetails.length > 0 ? (
          <View className="border-t border-border-subtle px-4 py-3">
            <View className="flex-row items-start justify-between gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground">Unassigned managed worktrees</Text>
                <Text className="mt-0.5 text-xs leading-normal text-foreground-muted">
                  No longer linked to a registered project. Always protected from manual and
                  automatic bulk pruning. Size is the sum of reported unassigned details.
                </Text>
              </View>
              <Text className="shrink-0 text-base tabular-nums text-foreground">
                {formatWorktreeStorageBytes(unassignedBytes)}
              </Text>
            </View>
            <View className="mt-2 ms-3 border-s border-border-subtle ps-3">
              {visibleUnassignedDetails.map((detail) => (
                <DetailRow key={detail.worktreePath} detail={detail} />
              ))}
            </View>
            {unassignedDetails.length > visibleUnassignedDetails.length ? (
              <Text className="mt-2 text-xs text-foreground-muted">
                Showing {visibleUnassignedDetails.length} of {unassignedDetails.length} unassigned
                worktrees.
              </Text>
            ) : null}
          </View>
        ) : null}

        {report &&
        (report.projects.length > projects.length ||
          report.projectCount > report.projects.length) ? (
          <Text className="border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted">
            Showing {projects.length} of {report.projectCount} projects, ranked by known bytes.
          </Text>
        ) : null}

        <PolicyControl
          environment={props.environment}
          disabled={!canManage || props.savingPolicy}
          onUpdate={props.onUpdatePolicy}
        />

        <Pressable
          accessibilityLabel={`Prune all stale worktrees on ${props.environment.label}`}
          accessibilityRole="button"
          disabled={!canManage || props.pruning}
          onPress={() => props.onConfirmPrune(props.environment.environmentId)}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 disabled:opacity-40"
        >
          <SymbolView name="trash" size={20} tintColor={dangerColor} type="monochrome" />
          <Text className="min-w-0 flex-1 text-base text-danger-foreground">
            Prune all stale worktrees on this system
          </Text>
          {props.pruning ? <ActivityIndicator color={dangerColor} /> : null}
        </Pressable>
      </SettingsSection>
      <Text className="px-2 text-xs leading-normal text-foreground-muted">
        Automatic pruning is stored on this system, not on this mobile device.
      </Text>
    </View>
  );
}

export function SettingsWorktreeStorageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const { environments, refresh } = useMobileWorktreeStorage();
  const coverage = useMemo(() => computeWorktreeStorageCoverage(environments), [environments]);
  const plan = useMemo(() => planAcrossEnvironmentPrune(environments), [environments]);
  const pruneStale = useAtomCommand(worktreeStorageEnvironment.pruneStale, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [pruning, setPruning] = useState(false);
  const [savingPolicyEnvironmentIds, setSavingPolicyEnvironmentIds] = useState<
    ReadonlySet<EnvironmentId>
  >(() => new Set());
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const mutationPending = useRef(false);
  const savingPolicyEnvironmentIdsRef = useRef<ReadonlySet<EnvironmentId>>(new Set());
  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;

  const updatePolicy = async (environmentId: EnvironmentId, policy: WorktreeAutoPrunePolicy) => {
    if (savingPolicyEnvironmentIdsRef.current.has(environmentId)) return;
    const pending = updatePendingEnvironmentIds(
      savingPolicyEnvironmentIdsRef.current,
      environmentId,
      true,
    );
    savingPolicyEnvironmentIdsRef.current = pending;
    setSavingPolicyEnvironmentIds(pending);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { worktreeAutoPrunePolicy: policy } },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        Alert.alert(
          "Policy update failed",
          cause instanceof Error ? cause.message : "Try again when this system is connected.",
        );
      }
    } finally {
      const remaining = updatePendingEnvironmentIds(
        savingPolicyEnvironmentIdsRef.current,
        environmentId,
        false,
      );
      savingPolicyEnvironmentIdsRef.current = remaining;
      setSavingPolicyEnvironmentIds(remaining);
    }
  };

  const executePrune = async (
    confirmedTargets: readonly FrozenMobileEnvironmentRef[],
    initiallySkipped: readonly FrozenMobileSkippedEnvironment[],
  ) => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setPruning(true);
    try {
      const currentEnvironments = environmentsRef.current;
      const currentPlan = resolveFrozenPrunePlan(
        currentEnvironments,
        confirmedTargets.map((environment) => environment.environmentId),
      );
      const targets = currentPlan.targets;
      const currentIds = new Set(
        currentEnvironments.map((environment) => environment.environmentId),
      );
      const disconnectedTargets: FrozenMobileSkippedEnvironment[] = [
        ...currentPlan.skipped.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          reason: worktreeStorageSkippedReason(environment),
        })),
        ...confirmedTargets
          .filter((environment) => !currentIds.has(environment.environmentId))
          .map((environment) => ({ ...environment, reason: "unavailable" as const })),
      ];
      const skippedEnvironments = [...initiallySkipped, ...disconnectedTargets];
      const results = await Promise.all(
        targets.map(async (environment) => ({
          environment,
          result: await pruneStale({ environmentId: environment.environmentId, input: {} }),
        })),
      );
      const resultOutcomes = results.map((entry): EnvironmentPruneOutcome => {
        if (entry.result._tag === "Success") {
          return successfulPruneOutcome(entry.environment, entry.result.value);
        }
        const cause = squashAtomCommandFailure(entry.result);
        return {
          environmentId: entry.environment.environmentId,
          label: entry.environment.label,
          status: "failure",
          error: cause instanceof Error ? cause.message : "Prune request failed.",
        };
      });
      const skippedOutcomes: readonly EnvironmentPruneOutcome[] = skippedEnvironments.map(
        (environment) => ({ ...environment, status: "skipped" }),
      );
      const outcomes = [...resultOutcomes, ...skippedOutcomes];
      const aggregate = summarizePruneOutcomes(outcomes);
      const summary = summarizeMobilePrune(aggregate);
      const skippedLabels = outcomes
        .filter((outcome) => outcome.status === "skipped")
        .map((outcome) => `${outcome.label} (${outcome.reason})`);
      const failedLabels = outcomes
        .filter((outcome) => outcome.status === "failure")
        .map((outcome) => outcome.label);
      const partialLabels = outcomes
        .filter((outcome) => outcome.status === "success" && outcome.partial)
        .map((outcome) => outcome.label);
      const resultDetails = [
        partialLabels.length > 0 ? `Partial: ${partialLabels.join(", ")}.` : null,
        skippedLabels.length > 0 ? `Skipped: ${skippedLabels.join(", ")}.` : null,
        failedLabels.length > 0 ? `Failed: ${failedLabels.join(", ")}.` : null,
      ].filter((detail): detail is string => detail !== null);
      const detailedSummary = [summary, ...resultDetails].join("\n");
      setLastSummary(detailedSummary);
      Alert.alert(
        aggregate.tone !== "success"
          ? "Prune finished with exceptions"
          : aggregate.removedCount > 0
            ? "Prune finished"
            : "No stale worktrees were pruned",
        detailedSummary,
      );
    } finally {
      setPruning(false);
      mutationPending.current = false;
    }
  };

  const confirmPrune = (environmentId: EnvironmentId | null) => {
    const candidates =
      environmentId === null
        ? environments
        : environments.filter((environment) => environment.environmentId === environmentId);
    const currentPlan = planAcrossEnvironmentPrune(candidates);
    const targets: readonly FrozenMobileEnvironmentRef[] = currentPlan.targets.map(
      ({ environmentId: id, label }) => ({ environmentId: id, label }),
    );
    const skipped: readonly FrozenMobileSkippedEnvironment[] = currentPlan.skipped.map(
      (environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        reason: worktreeStorageSkippedReason(environment),
      }),
    );
    const exactScope = targets.map((environment) => environment.label).join(", ");
    const skippedScope = skipped
      .map((environment) => `${environment.label} (${environment.reason})`)
      .join(", ");
    Alert.alert(
      environmentId === null
        ? `Prune across ${targets.length} connected ${targets.length === 1 ? "system" : "systems"}?`
        : `Prune all stale worktrees on ${targets[0]?.label ?? "this system"}?`,
      `Included: ${exactScope || "None"}.${skippedScope ? `\n\nSkipped: ${skippedScope}.` : ""}\n\nEach system performs a fresh safety check. Dirty, active, or unknown worktrees remain protected. Offline systems are not queued.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Prune all stale worktrees",
          style: "destructive",
          onPress: () => void executePrune(targets, skipped),
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Worktree Storage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Known worktree space">
          <View className="flex-row items-center gap-3 p-4">
            <SymbolView name="externaldrive" size={22} tintColor={iconColor} type="monochrome" />
            <View className="min-w-0 flex-1">
              <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                {coverage.knownEnvironmentCount > 0
                  ? formatWorktreeStorageBytes(coverage.totalKnownBytes)
                  : "Unknown"}
              </Text>
              <Text className="mt-0.5 text-sm leading-normal text-foreground-muted">
                Known across {coverage.knownEnvironmentCount} of {coverage.environmentCount}{" "}
                systems.
                {coverage.knownEnvironmentCount < coverage.environmentCount
                  ? " Missing systems are not counted as zero."
                  : ""}
                {coverage.partialCount > 0
                  ? ` ${coverage.partialCount} ${coverage.partialCount === 1 ? "report is" : "reports are"} partial; unknown storage is not counted as zero.`
                  : ""}
                {" Shared Git object storage is excluded."}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityLabel="Refresh worktree storage"
            accessibilityRole="button"
            disabled={plan.targets.length === 0}
            onPress={refresh}
            className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 disabled:opacity-40"
          >
            <SymbolView name="arrow.clockwise" size={20} tintColor={iconColor} type="monochrome" />
            <Text className="text-base text-foreground">Refresh now</Text>
          </Pressable>
        </SettingsSection>

        {environments.map((environment) => (
          <EnvironmentSection
            key={environment.environmentId}
            environment={environment}
            pruning={pruning}
            savingPolicy={savingPolicyEnvironmentIds.has(environment.environmentId)}
            onConfirmPrune={(environmentId) => confirmPrune(environmentId)}
            onUpdatePolicy={(environmentId, policy) => void updatePolicy(environmentId, policy)}
          />
        ))}

        <View className="gap-3">
          <SettingsSection title="Actions">
            <Pressable
              accessibilityLabel="Prune all stale worktrees across connected systems"
              accessibilityRole="button"
              disabled={pruning || plan.targets.length === 0}
              onPress={() => confirmPrune(null)}
              className="min-h-14 flex-row items-center gap-3 p-4 disabled:opacity-40"
            >
              <SymbolView name="trash" size={20} tintColor={dangerColor} type="monochrome" />
              <View className="min-w-0 flex-1">
                <Text className="text-base text-danger-foreground">
                  Prune all stale worktrees across connected systems
                </Text>
                <Text className="mt-0.5 text-xs text-foreground-muted">
                  {plan.targets.length} connected and capable · {plan.skipped.length} skipped
                </Text>
              </View>
              {pruning ? <ActivityIndicator color={dangerColor} /> : null}
            </Pressable>
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Pruning asks each connected system for a fresh safety check. Dirty, active, and unknown
            worktrees remain protected. Offline systems are never queued.
          </Text>
          {lastSummary ? (
            <Text
              accessibilityLiveRegion="polite"
              className="px-2 text-sm leading-normal text-foreground-muted"
            >
              Last prune: {lastSummary}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
