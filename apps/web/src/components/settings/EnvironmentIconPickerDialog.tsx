import {
  ENVIRONMENT_CURATED_ICON_IDS,
  ENVIRONMENT_ICON_LABELS,
  ENVIRONMENT_LUCIDE_ICON_IDS,
  environmentIconForCuratedId,
  environmentIconForMachineKind,
  isEnvironmentCuratedIconId,
  isEnvironmentLucideIconId,
  isEnvironmentMachineKind,
  isLegacyEnvironmentMachineKind,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentLucideIconId,
  type EnvironmentMachineKind,
  type IconColor,
  type ServerConfig,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { cn } from "~/lib/utils";
import {
  describeEnvironmentIconImageFailure,
  encodeEnvironmentIconImage,
} from "../../lib/environmentIconImage";
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

/** A Lucide id as a label: `hard-drive` reads as `Hard Drive`. */
function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** The shared Lucide ids whose name contains every word of `query`. */
export function filterEnvironmentLucideIconIds(
  query: string,
): ReadonlyArray<EnvironmentLucideIconId> {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return ENVIRONMENT_LUCIDE_ICON_IDS;
  return ENVIRONMENT_LUCIDE_ICON_IDS.filter((id) => words.every((word) => id.includes(word)));
}

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
    mode: current.kind satisfies EnvironmentIconDialogMode,
    iconId:
      current.kind === "icon" && isEnvironmentCuratedIconId(current.name)
        ? current.name
        : input.detected,
    lucideId:
      current.kind === "icon" && isEnvironmentLucideIconId(current.name) ? current.name : null,
    color: current.kind === "icon" || current.kind === "monogram" ? (current.color ?? null) : null,
    emoji: current.kind === "emoji" ? current.emoji : DEFAULT_EMOJI,
    monogram:
      current.kind === "monogram"
        ? current.text
        : deriveProjectIdentity(input.environmentLabel).monogram,
    imageDataUrl: current.kind === "image" ? current.dataUrl : null,
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
  const [lucideId, setLucideId] = useState<EnvironmentLucideIconId | null>(initial.lucideId);
  const [query, setQuery] = useState("");
  const [color, setColor] = useState<IconColor | null>(initial.color);
  const [emoji, setEmoji] = useState(initial.emoji);
  const [monogram, setMonogram] = useState(initial.monogram);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(initial.imageDataUrl);
  const [imageError, setImageError] = useState<string | null>(null);
  const [customEmoji, setCustomEmoji] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      const next = initialState({ current, detected, environmentLabel });
      setMode(next.mode);
      setIconId(next.iconId);
      setLucideId(next.lucideId);
      setQuery("");
      setColor(next.color);
      setEmoji(next.emoji);
      setMonogram(next.monogram);
      setImageDataUrl(next.imageDataUrl);
      setImageError(null);
      setCustomEmoji("");
    }
    previousOpenRef.current = open;
  }, [current, detected, environmentLabel, open]);

  const richLock = resolveEnvironmentRichIconLock(serverConfig);
  const lucideIds = useMemo(() => filterEnvironmentLucideIconIds(query), [query]);
  const write = resolveEnvironmentIconDialogWrite({
    mode,
    iconId,
    lucideId,
    color,
    emoji,
    monogram,
    imageDataUrl,
    detected,
  });
  const handleImageFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const result = await encodeEnvironmentIconImage(file);
    if (result.ok) {
      setImageDataUrl(result.dataUrl);
      setImageError(null);
    } else {
      setImageError(describeEnvironmentIconImageFailure(result.reason));
    }
  };
  // Anything beyond a plain machine kind travels as the object form, which
  // only a server with the override capability stores.
  const writeLocked =
    richLock !== null &&
    (mode !== "icon" ||
      color !== null ||
      lucideId !== null ||
      !isLegacyEnvironmentMachineKind(iconId));
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
                if (
                  value === "icon" ||
                  value === "emoji" ||
                  value === "monogram" ||
                  value === "image"
                ) {
                  setMode(value);
                }
              }}
            >
              <Toggle value="icon">Icons</Toggle>
              <Toggle value="emoji" disabled={richLock !== null}>
                Emoji
              </Toggle>
              <Toggle value="monogram" disabled={richLock !== null}>
                Monogram
              </Toggle>
              <Toggle value="image" disabled={richLock !== null}>
                Image
              </Toggle>
            </ToggleGroup>
          </div>

          {richLock !== null ? <p className="text-xs text-muted-foreground">{richLock}</p> : null}

          {mode === "icon" || mode === "monogram" ? (
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
            <>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3" role="group" aria-label="Icon">
                {ENVIRONMENT_CURATED_ICON_IDS.map((id) => {
                  const lock = resolveEnvironmentIconChoiceLock({ serverConfig, id });
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={lucideId === null && iconId === id}
                      disabled={lock !== null}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
                        lucideId === null && iconId === id && "border-border bg-accent",
                      )}
                      onClick={() => {
                        setIconId(id);
                        setLucideId(null);
                      }}
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
              <Input
                type="search"
                value={query}
                aria-label="Search more icons"
                placeholder="Search more icons"
                disabled={richLock !== null}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-40">
                <div
                  className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10"
                  role="group"
                  aria-label="More icons"
                >
                  {lucideIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={iconLabel(id)}
                      aria-pressed={lucideId === id}
                      disabled={richLock !== null}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
                        lucideId === id && "border-border bg-accent",
                      )}
                      onClick={() => setLucideId(id)}
                    >
                      <EnvironmentMachineIcon
                        icon={
                          color === null
                            ? { kind: "icon", name: id }
                            : { kind: "icon", name: id, color }
                        }
                        className="size-5"
                      />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {lucideIds.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
          ) : mode === "image" ? (
            <div className="flex items-center gap-4 py-2">
              {imageDataUrl !== null ? (
                <EnvironmentMachineIcon
                  icon={{ kind: "image", dataUrl: imageDataUrl }}
                  className="size-12 shrink-0"
                />
              ) : (
                <span className="size-12 shrink-0 rounded-[25%] border border-dashed border-muted-foreground" />
              )}
              <div className="flex-1 space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="sr-only"
                  onChange={(event) => void handleImageFile(event)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {imageDataUrl === null ? "Choose image" : "Replace image"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {imageError ?? "Cropped to a square and stored at 64 by 64."}
                </p>
              </div>
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
