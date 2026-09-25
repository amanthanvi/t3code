import {
  ENVIRONMENT_ICON_LABELS,
  isEnvironmentCuratedIconId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
} from "@t3tools/contracts";
import { Platform, Text, View } from "react-native";

import { cn } from "../lib/cn";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { ENVIRONMENT_ICON_COLOR_CLASSES } from "./environmentIconColors";
import { monogramCharacters } from "./environmentMonogram";

// Every SF name here is already a key of the Android fallback map, so a new
// id costs Metro nothing; only iOS needs a look to confirm the glyph exists.
const SYMBOL_BY_ID: Record<EnvironmentCuratedIconId, AppSymbolName> = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
  terminal: "terminal",
  database: "internaldrive",
  container: "cube",
  globe: "globe",
  home: "house",
  gpu: "brain",
  network: "point.3.connected.trianglepath.dotted",
};

/**
 * The glyph an environment wears in lists; SF Symbols on iOS, Tabler on
 * Android. A name this build cannot draw (picked on a newer client) gets the
 * generic server so the row still reads as a machine. `tintColorClassName`
 * is the caller's resting tint; a chosen color replaces it. Rows draw
 * connection state beside the glyph, never on it, so a red icon never reads
 * as a failed one. Emoji and monograms get an explicit width, because emoji
 * advance widths vary per glyph and platform and these sit in flex rows.
 */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const { icon, size } = props;
  if (icon.kind === "emoji") {
    return (
      <Text
        accessibilityLabel={icon.emoji}
        allowFontScaling={false}
        numberOfLines={1}
        style={{
          width: size,
          fontSize: size * 0.8,
          lineHeight: size,
          textAlign: "center",
          ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
        }}
      >
        {icon.emoji}
      </Text>
    );
  }
  if (icon.kind === "monogram") {
    const color = ENVIRONMENT_ICON_COLOR_CLASSES[icon.color ?? "gray"];
    const characters = monogramCharacters(icon.text);
    return (
      <View
        accessible
        accessibilityLabel={icon.text}
        className={cn("items-center justify-center", color.tile)}
        style={{ width: size, height: size, borderRadius: size * 0.25 }}
      >
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          className={cn("font-t3-bold", color.text)}
          style={{
            fontSize: size * (characters.length > 1 ? 0.5 : 0.62),
            lineHeight: size,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
          }}
        >
          {characters.join("")}
        </Text>
      </View>
    );
  }
  const id = icon.kind === "icon" && isEnvironmentCuratedIconId(icon.name) ? icon.name : "server";
  const tintColorClassName =
    icon.kind === "icon" && icon.color !== undefined
      ? ENVIRONMENT_ICON_COLOR_CLASSES[icon.color].tint
      : props.tintColorClassName;
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_ICON_LABELS[id]}
      name={SYMBOL_BY_ID[id]}
      size={size}
      tintColorClassName={tintColorClassName}
      type="monochrome"
    />
  );
}
