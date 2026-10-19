import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerRecoveryCheckpointAlarm } from "../background/recovery-scheduler.js";

describe("Recovery checkpoint alarm", () => {
  test("creates a one-minute alarm and invokes capture only for its alarm", async () => {
    const listeners = [];
    const created = [];
    let captures = 0;
    const chromeApi = {
      alarms: {
        create: async (...args) => created.push(args),
        onAlarm: { addListener: listener => listeners.push(listener) }
      }
    };

    registerRecoveryCheckpointAlarm(chromeApi, async () => { captures++; });
    await new Promise(resolve => setImmediate(resolve));
    listeners[0]({ name: "some-other-alarm" });
    listeners[0]({ name: "synctab-recovery-checkpoint" });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(created, [["synctab-recovery-checkpoint", { periodInMinutes: 1 }]]);
    assert.equal(captures, 1);
  });

  test("coalesces overlapping alarm events while a capture is in progress", async () => {
    const listeners = [];
    let releaseCapture;
    let captures = 0;
    const captureGate = new Promise(resolve => { releaseCapture = resolve; });
    const chromeApi = {
      alarms: {
        create: async () => {},
        onAlarm: { addListener: listener => listeners.push(listener) }
      }
    };
    registerRecoveryCheckpointAlarm(chromeApi, async () => {
      captures++;
      await captureGate;
    });

    listeners[0]({ name: "synctab-recovery-checkpoint" });
    await new Promise(resolve => setImmediate(resolve));
    listeners[0]({ name: "synctab-recovery-checkpoint" });
    assert.equal(captures, 1);
    releaseCapture();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captures, 1);
  });
});
