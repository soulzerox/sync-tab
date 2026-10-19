import { RECOVERY_CHECKPOINT_ALARM } from "../shared/constants.js";

/**
 * Registers the periodic recovery checkpoint alarm for a service worker lifetime.
 * @param {any} chromeApi
 * @param {() => Promise<void>} captureCheckpoint
 * @returns {() => void} Removes the listener (useful for tests).
 */
export function registerRecoveryCheckpointAlarm(chromeApi, captureCheckpoint) {
  const alarms = chromeApi?.alarms;
  if (!alarms?.create || !alarms.onAlarm?.addListener) return () => {};

  try {
    Promise.resolve(alarms.create(RECOVERY_CHECKPOINT_ALARM, { periodInMinutes: 1 }))
      .catch(error => console.warn("[SyncTab] Could not schedule recovery checkpoint:", error));
  } catch (error) {
    console.warn("[SyncTab] Could not schedule recovery checkpoint:", error);
  }

  let captureInFlight = null;
  const listener = alarm => {
    if (alarm?.name !== RECOVERY_CHECKPOINT_ALARM || captureInFlight) return;
    captureInFlight = Promise.resolve()
      .then(captureCheckpoint)
      .catch(error => console.warn("[SyncTab] Recovery checkpoint failed:", error))
      .finally(() => { captureInFlight = null; });
  };

  alarms.onAlarm.addListener(listener);
  return () => alarms.onAlarm.removeListener?.(listener);
}
