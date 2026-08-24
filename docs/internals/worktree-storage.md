# Worktree storage management

Worktree storage management reports and prunes T3 Code-managed worktrees without turning one
server into an authority over another server's filesystem. Each environment scans and mutates only
its own worktree directory. Web and mobile clients build the across-systems view by sending the same
typed request to each connected environment that advertises the optional `worktreeStorage`
capability.

## Accounting

The server discovers linked worktree roots below its configured worktree directory without
following directory symlinks. Directory reads are rejected when the path's device or inode changes
during traversal. It measures apparent checkout bytes with bounded entry, time, error, candidate,
and response budgets. Shared Git object storage is not attributed to a linked worktree, so reported
bytes are an estimate rather than a promise about space reclaimed by deletion.

Each physical checkout contributes bytes once. If threads from multiple projects reference the
same checkout, the report attributes it to one deterministic associated project and marks the
detail as shared across projects; project aggregates therefore never multiply system storage.

The time budget bounds when a scan returns and prevents late filesystem results from influencing a
deletion decision. Node's `lstat` and `readdir` promises are not cancellable, so an operating-system
request that outlives the deadline may still settle later and is ignored.

The entry budget limits names queued and visited after each directory read. Node's `readdir` still
materializes one directory's names before that budget is applied, so a pathologically wide single
directory can require more transient memory than the traversal entry limit suggests. Replacing
path-based reads with incremental directory handles is the follow-up if this becomes operationally
significant.

Reports carry explicit `partial`, error, and bounded returned-count fields. Clients may sum the
known bytes across environments, but must keep offline, unsupported, failed, and partial systems
qualified instead of treating them as zero or complete.

## Eligibility and protection

The server derives candidates from current and archived thread projections plus inventory under the
managed root. Inventory-only worktrees are reported as unassigned but are always protected from
bulk pruning because the server has no durable activity record for them.

Before removal, a candidate must remain all of the following:

- canonically below the managed worktree root and registered by Git;
- distinct from the main checkout, attached, unlocked, and not marked prunable;
- clean, with no untracked files, ahead commits, or commits absent from a remote ref;
- associated only with stale threads and free of active turns, sessions, terminals, providers,
  approvals, user input, plans, and background liveness;
- fully inspectable within every safety budget.

Unknown state protects the candidate. Physical deletion uses `git worktree remove <path>` without
`--force`.

## Destructive sequence

Prunes are serialized within a server process. Every candidate is rescanned before the server
reserves its associated thread paths with an expected-path compare-and-swap. The service verifies
the exact persisted metadata event and reloads projections and live process summaries before a
final filesystem and Git inspection.

The reservation scope makes an uninterruptible attempt to restore cleared paths with an
expected-null compare-and-swap on failure or interruption. Once bounded Git removal starts, the
server observes its result without interruption; successful removal commits the cleared
association, while failed removal attempts to restore it. Expected-path metadata updates preserve
the thread's durable activity timestamp so the reservation itself cannot make an
inactivity-qualified candidate recent.

A hard process stop or a defect in the restoration path can strand a thread's worktree association
as cleared. The physical checkout remains discoverable after restart and is then protected as an
unassigned worktree; recovering the association requires operator repair. Eliminating this metadata
recovery case requires a durable reservation journal and startup reconciliation, which this design
does not provide.

This is a conservative application-level transaction, not a global filesystem lease. T3-controlled
live activity is checked immediately before removal, and Git's non-force removal remains the final
dirty-data guard. Separate server processes and other same-user filesystem writers are not
admission-locked: they can change a path after a canonical or status check, and Git's own status and
recursive removal are not one atomic filesystem operation. This flow does not claim safety against
a hostile same-user writer racing those checks. Maintainers extending it must preserve fail-closed
inspection and must not replace non-force removal with forced deletion.

## Automatic policies

Automatic pruning is hosted by each server and defaults to `off`.

- `on-settle` runs when that policy is enabled or changed and when a thread settles or is archived.
- `after-inactive-days` runs when that policy is enabled or changed and on the bounded periodic
  fallback sweep.

Unrelated settings changes do not trigger a scan. Both automatic modes call the same serialized,
revalidating prune path as the manual RPC.
