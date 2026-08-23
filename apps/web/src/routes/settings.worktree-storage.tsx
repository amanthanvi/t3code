import { createFileRoute } from "@tanstack/react-router";

import { WorktreeStorageSettings } from "../components/settings/WorktreeStorageSettings";

export const Route = createFileRoute("/settings/worktree-storage")({
  component: WorktreeStorageSettings,
});
