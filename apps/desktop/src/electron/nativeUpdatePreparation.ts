import type * as NodeEvents from "node:events";

type NativeUpdater = Pick<NodeEvents.EventEmitter, "once" | "removeListener"> & {
  readonly checkForUpdates: () => void;
};

export function makeNativeUpdatePreparation(updater: NativeUpdater) {
  let generation = 0;
  let preparedGeneration: number | undefined;
  let inFlight: { readonly generation: number; readonly promise: Promise<void> } | undefined;

  const prepare = async (): Promise<void> => {
    if (preparedGeneration === generation) return;
    if (inFlight !== undefined) {
      const previous = inFlight;
      try {
        await previous.promise;
      } catch (cause) {
        if (previous.generation === generation) throw cause;
      }
      return prepare();
    }
    const currentGeneration = generation;
    const ready = Promise.withResolvers<void>();
    const removeListeners = () => {
      updater.removeListener("update-downloaded", onReady);
      updater.removeListener("update-not-available", onUnavailable);
      updater.removeListener("error", onError);
    };
    const onReady = () => {
      removeListeners();
      if (generation === currentGeneration) preparedGeneration = currentGeneration;
      inFlight = undefined;
      ready.resolve();
    };
    const onError = (cause: unknown) => {
      removeListeners();
      inFlight = undefined;
      ready.reject(cause);
    };
    const onUnavailable = () => onError(new Error("The native updater did not prepare an update."));
    // Electron has no cancel-check API; retain the flight across caller cancellation to drain stale events.
    inFlight = { generation: currentGeneration, promise: ready.promise };
    updater.once("update-downloaded", onReady);
    updater.once("update-not-available", onUnavailable);
    updater.once("error", onError);
    try {
      updater.checkForUpdates();
    } catch (cause) {
      onError(cause);
    }
    await ready.promise;
  };
  return {
    prepare,
    reset: () => {
      generation += 1;
      preparedGeneration = undefined;
    },
  };
}
