import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface KeyedLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

export interface KeyedLockPool {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly size: Effect.Effect<number>;
}

/** A keyed mutex pool that retains keys only while holders or waiters exist. */
export const makeKeyedLockPool = Effect.fn("makeKeyedLockPool")(function* () {
  const locksRef = yield* SynchronizedRef.make(new Map<string, KeyedLockEntry>());

  const acquireLock = Effect.fn("keyedLockPool.acquireLock")(function* (key: string) {
    return yield* SynchronizedRef.modifyEffect(locksRef, (current) => {
      const existing = current.get(key);
      if (existing) {
        const next = new Map(current);
        next.set(key, { ...existing, users: existing.users + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, { semaphore, users: 1 });
          return [semaphore, next] as const;
        }),
      );
    });
  });

  const releaseLock = Effect.fn("keyedLockPool.releaseLock")(function* (
    key: string,
    semaphore: Semaphore.Semaphore,
  ) {
    yield* SynchronizedRef.update(locksRef, (current) => {
      const existing = current.get(key);
      if (!existing || existing.semaphore !== semaphore) {
        return current;
      }
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });
  });

  const withLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireLock(key),
      (semaphore) => semaphore.withPermit(effect),
      (semaphore) => releaseLock(key, semaphore),
    );

  return {
    withLock,
    size: SynchronizedRef.get(locksRef).pipe(Effect.map((locks) => locks.size)),
  } satisfies KeyedLockPool;
});
