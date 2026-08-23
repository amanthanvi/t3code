# Manage worktree storage

Open **Settings → Worktree Storage** on web or desktop to review the disk space used by T3 Code
worktrees. On mobile, open **Settings → Worktree Storage** under Configuration. This is separate from
**Client Storage**, which manages offline caches stored on the mobile device.

The total at the top includes only systems that successfully reported their storage. Offline,
unsupported, and failed systems remain unknown; T3 Code does not count them as zero. Systems and
projects are ranked by known bytes, with a bounded list of worktrees for detail. Select **Refresh
now** or the refresh button to request a new scan. Worktree storage is not polled continuously.

Totals are known checkout or apparent bytes. Shared Git object storage is excluded, and filesystem
allocation means the disk space actually freed by pruning can differ from the estimate.

## Protected worktrees

T3 Code identifies stale worktrees on the system that owns them. Before removing anything, that
system performs fresh safety checks. Worktrees stay protected when they are dirty, active, locked,
ahead of their remote, waiting for input or approval, used by a live provider or terminal, outside
managed storage, or cannot be inspected safely. The Worktree Storage page shows these protection
reasons without presenting protected worktrees as removable.

Managed worktrees that are no longer linked to a registered project appear under **Unassigned
managed worktrees**. Because T3 Code no longer has a durable activity record for them, both manual
and automatic bulk pruning always leave them protected; they are still included in the reported
storage total.

## Prune all stale worktrees

Use **Prune all stale worktrees on this system** to prune one connected system. Use **Prune all
stale worktrees across connected systems** to request pruning from every system that is connected
and supports the feature.

An across-systems request does not queue work for offline systems. Each connected system performs
its own fresh prune, and T3 Code reports removed, protected, skipped, and failed results separately.
A partial success is not reported as a complete success.

## Automatic pruning

Automatic pruning is configured separately for each system. Changing one system's policy does not
change another system or create a device-wide setting. Available policies are:

- **Off** — never prune automatically.
- **When threads settle** — check for safely removable stale worktrees when their threads settle.
- **After inactivity** — check after the selected number of inactive days, from 1 through 365.
  This policy does not require the thread to be settled; worktrees with live sessions, pending work,
  or any other protection reason still remain protected.

Choose a mode, enter the inactivity period when needed, then select **Apply** or **Apply policy**.
Changing the draft alone does not enable automatic pruning.

Automatic policies use the same safety checks as a manual prune. Dirty, active, and unknown
worktrees remain protected.
