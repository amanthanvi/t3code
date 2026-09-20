import type { IconColor } from "@t3tools/contracts";

/**
 * Class names for a user-chosen icon color, one 600/400 pair per color so
 * light and dark themes match what web draws. Written out in full because
 * Uniwind only ships utilities it can find in source.
 */
export const ENVIRONMENT_ICON_COLOR_CLASSES: Record<
  IconColor,
  { readonly tint: string; readonly text: string; readonly tile: string }
> = {
  gray: {
    tint: "accent-adaptive-gray-600-400",
    text: "text-adaptive-gray-600-400",
    tile: "bg-adaptive-gray-600-400/14",
  },
  red: {
    tint: "accent-adaptive-red-600-400",
    text: "text-adaptive-red-600-400",
    tile: "bg-adaptive-red-600-400/14",
  },
  orange: {
    tint: "accent-adaptive-orange-600-400",
    text: "text-adaptive-orange-600-400",
    tile: "bg-adaptive-orange-600-400/14",
  },
  amber: {
    tint: "accent-adaptive-amber-600-400",
    text: "text-adaptive-amber-600-400",
    tile: "bg-adaptive-amber-600-400/14",
  },
  yellow: {
    tint: "accent-adaptive-yellow-600-400",
    text: "text-adaptive-yellow-600-400",
    tile: "bg-adaptive-yellow-600-400/14",
  },
  lime: {
    tint: "accent-adaptive-lime-600-400",
    text: "text-adaptive-lime-600-400",
    tile: "bg-adaptive-lime-600-400/14",
  },
  green: {
    tint: "accent-adaptive-green-600-400",
    text: "text-adaptive-green-600-400",
    tile: "bg-adaptive-green-600-400/14",
  },
  emerald: {
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
    tile: "bg-adaptive-emerald-600-400/14",
  },
  teal: {
    tint: "accent-adaptive-teal-600-400",
    text: "text-adaptive-teal-600-400",
    tile: "bg-adaptive-teal-600-400/14",
  },
  cyan: {
    tint: "accent-adaptive-cyan-600-400",
    text: "text-adaptive-cyan-600-400",
    tile: "bg-adaptive-cyan-600-400/14",
  },
  sky: {
    tint: "accent-adaptive-sky-600-400",
    text: "text-adaptive-sky-600-400",
    tile: "bg-adaptive-sky-600-400/14",
  },
  blue: {
    tint: "accent-adaptive-blue-600-400",
    text: "text-adaptive-blue-600-400",
    tile: "bg-adaptive-blue-600-400/14",
  },
  indigo: {
    tint: "accent-adaptive-indigo-600-400",
    text: "text-adaptive-indigo-600-400",
    tile: "bg-adaptive-indigo-600-400/14",
  },
  violet: {
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
    tile: "bg-adaptive-violet-600-400/14",
  },
  purple: {
    tint: "accent-adaptive-purple-600-400",
    text: "text-adaptive-purple-600-400",
    tile: "bg-adaptive-purple-600-400/14",
  },
  fuchsia: {
    tint: "accent-adaptive-fuchsia-600-400",
    text: "text-adaptive-fuchsia-600-400",
    tile: "bg-adaptive-fuchsia-600-400/14",
  },
  pink: {
    tint: "accent-adaptive-pink-600-400",
    text: "text-adaptive-pink-600-400",
    tile: "bg-adaptive-pink-600-400/14",
  },
  rose: {
    tint: "accent-adaptive-rose-600-400",
    text: "text-adaptive-rose-600-400",
    tile: "bg-adaptive-rose-600-400/14",
  },
};
