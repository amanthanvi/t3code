import {
  ENVIRONMENT_ICON_LABELS,
  resolveEnvironmentIcon,
  type EnvironmentIcon,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";
import {
  describeEnvironmentIconImageFailure,
  pickEnvironmentIconImage,
} from "../../lib/environmentIconImage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  listMobileEnvironmentIconChoices,
  resolveMobileEnvironmentIconWrite,
  selectedMobileEnvironmentIconId,
  supportsRichEnvironmentIcon,
} from "./environmentIconPicker.logic";

/**
 * Picks an environment's icon: the curated list, or a photo cropped to a
 * 64 by 64 tile. Emoji and monograms are entered on web, where there is a
 * keyboard; this sheet still draws whatever was picked there. Writes go
 * through the same settings command the settings screens use, so a server
 * that rejects the value reports it the same way.
 */
export function EnvironmentIconPickerSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly serverConfig: ServerConfig | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment icon update",
    reportFailure: true,
  });
  const [pending, setPending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  // With no detection the server falls back to "server", so picking that
  // kind clears the override the same way picking the detected kind does.
  const detected = props.serverConfig?.environment.platform.machine ?? "server";
  const current = resolveEnvironmentIcon(props.serverConfig);
  const selectedId = selectedMobileEnvironmentIconId(current);
  const rich = supportsRichEnvironmentIcon(props.serverConfig);
  const choices = listMobileEnvironmentIconChoices({ serverConfig: props.serverConfig, detected });

  const applyIcon = async (environmentIcon: EnvironmentIcon | null) => {
    const result = await updateSettings({
      environmentId: props.environmentId,
      input: { patch: { environmentIcon } },
    });
    if (AsyncResult.isSuccess(result)) props.onClose();
  };
  const write = async (environmentIcon: EnvironmentIcon | null) => {
    if (pending) return;
    setPending(true);
    try {
      await applyIcon(environmentIcon);
    } finally {
      setPending(false);
    }
  };
  // The native picker, the decode, and the encode all run before the write, so
  // the pending window has to open here rather than inside `write`.
  const pickImage = async () => {
    if (pending) return;
    setImageError(null);
    setPending(true);
    try {
      const result = await pickEnvironmentIconImage();
      if (result.ok) {
        await applyIcon({ kind: "image", dataUrl: result.dataUrl });
      } else if (result.reason !== "cancelled") {
        setImageError(describeEnvironmentIconImageFailure(result.reason));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      onRequestClose={props.onClose}
    >
      <View
        className={
          Platform.OS === "android" ? "flex-1 justify-end bg-backdrop" : "flex-1 justify-end"
        }
      >
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss icon picker"
            onPress={props.onClose}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
        ) : null}
        <View
          className="overflow-hidden rounded-t-3xl bg-sheet-solid"
          style={Platform.OS === "android" ? { maxHeight: "85%" } : { flex: 1 }}
        >
          <View className="flex-row items-center justify-between gap-3 border-b border-border px-4 pb-2 pt-4">
            <EnvironmentMachineSymbol
              icon={current}
              size={22}
              tintColorClassName="accent-foreground-muted"
            />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-semibold text-foreground" numberOfLines={1}>
                Environment icon
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                Every device that connects to {props.environmentLabel} sees this icon.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close icon picker"
              onPress={props.onClose}
              className="p-3"
            >
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
          >
            <View accessibilityRole="radiogroup" accessibilityLabel="Icon">
              {choices.map((choice, index) => (
                <Pressable
                  key={choice.id}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: selectedId === choice.id,
                    disabled: !choice.enabled || pending,
                  }}
                  disabled={!choice.enabled || pending}
                  onPress={() =>
                    void write(resolveMobileEnvironmentIconWrite({ next: choice.id, detected }))
                  }
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3 active:opacity-70",
                    index > 0 && "border-t border-border",
                    !choice.enabled && "opacity-40",
                  )}
                >
                  <EnvironmentMachineSymbol
                    icon={choice.icon}
                    size={20}
                    tintColorClassName="accent-icon"
                  />
                  <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                    {ENVIRONMENT_ICON_LABELS[choice.id]}
                  </Text>
                  {choice.detected ? (
                    <Text className="text-xs text-foreground-muted">
                      {props.serverConfig?.environment.platform.machine ? "detected" : "default"}
                    </Text>
                  ) : null}
                  {selectedId === choice.id ? (
                    <SymbolView
                      name="checkmark"
                      size={14}
                      tintColorClassName="accent-primary"
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !rich || pending }}
              disabled={!rich || pending}
              onPress={() => void pickImage()}
              className={cn(
                "flex-row items-center gap-3 border-t border-border px-4 py-3 active:opacity-70",
                !rich && "opacity-40",
              )}
            >
              {current.kind === "image" ? (
                <EnvironmentMachineSymbol
                  icon={current}
                  size={20}
                  tintColorClassName="accent-icon"
                />
              ) : (
                <SymbolView
                  name="photo"
                  size={20}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              )}
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {current.kind === "image" ? "Replace photo" : "Choose a photo"}
                </Text>
                <Text
                  accessibilityLiveRegion={imageError === null ? "none" : "polite"}
                  className="text-xs text-foreground-muted"
                  numberOfLines={2}
                >
                  {imageError ??
                    (rich
                      ? "Cropped to a square and stored at 64 by 64."
                      : "Update this environment's server to pick an icon beyond its machine kind.")}
                </Text>
              </View>
              {current.kind === "image" ? (
                <SymbolView
                  name="checkmark"
                  size={14}
                  tintColorClassName="accent-primary"
                  type="monochrome"
                />
              ) : null}
            </Pressable>
            {current.kind === "emoji" || current.kind === "monogram" ? (
              <Text className="px-4 pt-3 text-xs text-foreground-muted">
                The current {current.kind} was set on web. Picking here replaces it.
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
