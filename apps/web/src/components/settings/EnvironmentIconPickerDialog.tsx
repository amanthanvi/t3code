import {
  ENVIRONMENT_CURATED_ICON_IDS,
  ENVIRONMENT_ICON_LABELS,
  environmentIconForCuratedId,
  environmentIconForMachineKind,
  isEnvironmentCuratedIconId,
  isEnvironmentMachineKind,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
  type IconColor,
  type ServerConfig,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { firstEmoji, PROJECT_EMOJIS } from "../../iconEmoji";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  resolveEnvironmentIconChoiceLock,
  resolveEnvironmentIconDialogWrite,
  resolveEnvironmentRichIconLock,
  type EnvironmentIconDialogMode,
} from "./EnvironmentIconPicker.logic";

const DEFAULT_EMOJI = "💻";

/**
 * The dialog's state for the current pick. Each mode starts from what is
 * stored, or from a sensible default.
 */
function initialState(input: {
  readonly current: EnvironmentIcon;
  readonly detected: EnvironmentMachineKind;
  readonly environmentLabel: string;
}) {
  const { current } = input;
  return {
    mode: (current.kind === "image" ? "icon" : current.kind) satisfies EnvironmentIconDialogMode,
    iconId:
      current.kind === "icon" && isEnvironmentCuratedIconId(current.name)
        ? current.name
        : input.detected,
    color: current.kind === "icon" || current.kind === "monogram" ? (current.color ?? null) : null,
    emoji: current.kind === "emoji" ? current.emoji : DEFAULT_EMOJI,
    monogram:
      current.kind === "monogram"
        ? current.text
        : deriveProjectIdentity(input.environmentLabel).monogram,
  };
}

/**
 * Picks an environment's icon: a curated glyph with an optional color, an
 * emoji, or a monogram. Every decision about what to write lives in
 * `EnvironmentIconPicker.logic.ts`; this component only holds the form state.
 */
export function EnvironmentIconPickerDialog({
  current,
  detected,
  environmentLabel,
  serverConfig,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: EnvironmentIcon;
  readonly detected: EnvironmentMachineKind;
  readonly environmentLabel: string;
  readonly serverConfig: ServerConfig | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: EnvironmentIcon | null) => void;
}) {
  const initial = initialState({ current, detected, environmentLabel });
  const [mode, setMode] = useState<EnvironmentIconDialogMode>(initial.mode);
  const [iconId, setIconId] = useState<EnvironmentCuratedIconId>(initial.iconId);
  const [color, setColor] = useState<IconColor | null>(initial.color);
  const [emoji, setEmoji] = useState(initial.emoji);
  const [monogram, setMonogram] = useState(initial.monogram);
  const [customEmoji, setCustomEmoji] = useState("");
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      const next = initialState({ current, detected, environmentLabel });
      setMode(next.mode);
      setIconId(next.iconId);
      setColor(next.color);
      setEmoji(next.emoji);
      setMonogram(next.monogram);
      setCustomEmoji("");
    }
    previousOpenRef.current = open;
  }, [current, detected, environmentLabel, open]);

  const richLock = resolveEnvironmentRichIconLock(serverConfig);
  const write = resolveEnvironmentIconDialogWrite({
    mode,
    iconId,
    color,
    emoji,
    monogram,
    detected,
  });
  // Anything beyond a plain machine kind travels as the object form, which
  // only a server with the override capability stores.
  const writeLocked =
    richLock !== null && (mode !== "icon" || color !== null || !isEnvironmentMachineKind(iconId));
  const canSave = write.kind === "write" && !writeLocked;
  const save = () => {
    if (write.kind !== "write" || writeLocked) return;
    onSelect(write.icon);
    onOpenChange(false);
  };
  const preview: EnvironmentIcon =
    write.kind === "write" && write.icon !== null
      ? write.icon
      : environmentIconForMachineKind(detected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Choose environment icon</DialogTitle>
          <DialogDescription>
            Every device that connects to {environmentLabel} sees this icon.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3">
            <EnvironmentMachineIcon icon={preview} className="size-8 shrink-0" />
            <ToggleGroup
              aria-label="Icon type"
              variant="segmented"
              className="flex-1"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "icon" || value === "emoji" || value === "monogram") setMode(value);
              }}
            >
              <Toggle value="icon">Icons</Toggle>
              <Toggle value="emoji" disabled={richLock !== null}>
                Emoji
              </Toggle>
              <Toggle value="monogram" disabled={richLock !== null}>
                Monogram
              </Toggle>
            </ToggleGroup>
          </div>

          {richLock !== null ? <p className="text-xs text-muted-foreground">{richLock}</p> : null}

          {mode !== "emoji" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                <button
                  type="button"
                  aria-label="Default"
                  aria-pressed={color === null}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    color === null && "border-foreground/64",
                  )}
                  onClick={() => setColor(null)}
                >
                  <span className="size-4 rounded-full border border-dashed border-muted-foreground" />
                </button>
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === option.value}
                    disabled={richLock !== null}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                      color === option.value && "border-foreground/64",
                    )}
                    onClick={() => setColor(option.value)}
                  >
                    <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "icon" ? (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3" role="group" aria-label="Icon">
              {ENVIRONMENT_CURATED_ICON_IDS.map((id) => {
                const lock = resolveEnvironmentIconChoiceLock({ serverConfig, id });
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={iconId === id}
                    disabled={lock !== null}
                    className={cn(
                      "flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
                      iconId === id && "border-border bg-accent",
                    )}
                    onClick={() => setIconId(id)}
                  >
                    <EnvironmentMachineIcon
                      icon={
                        color === null
                          ? environmentIconForCuratedId(id)
                          : { kind: "icon", name: id, color }
                      }
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{ENVIRONMENT_ICON_LABELS[id]}</span>
                    {id === detected ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {serverConfig?.environment.platform.machine ? "detected" : "default"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : mode === "monogram" ? (
            <div className="space-y-2">
              <label htmlFor="environment-monogram" className="text-sm font-medium">
                Letters
              </label>
              <Input
                id="environment-monogram"
                value={monogram}
                onChange={(event) => setMonogram(event.currentTarget.value)}
                aria-describedby="environment-monogram-hint"
                aria-invalid={write.kind === "invalid"}
                autoComplete="off"
              />
              <p id="environment-monogram-hint" className="text-xs text-muted-foreground">
                {write.kind === "invalid" ? write.reason : "One or two letters or numbers."}
              </p>
            </div>
          ) : (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={emoji === option.emoji}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                        emoji === option.emoji && "border-border bg-accent",
                      )}
                      onClick={() => setEmoji(option.emoji)}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Or paste any emoji
                </div>
                <Input
                  value={customEmoji}
                  aria-label="Custom emoji"
                  aria-invalid={customEmoji.trim().length > 0 && firstEmoji(customEmoji) === null}
                  placeholder="Paste an emoji"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomEmoji(value);
                    const nextEmoji = firstEmoji(value);
                    if (nextEmoji) setEmoji(nextEmoji);
                  }}
                />
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
