// clock panel — the FR3 fallback: always available (device RTC, no host data), page:'home' so the
// cycler runs deleteIfCommitted -> sendClock -> goHome and then writes NOTHING for the rest of the
// dwell (native home clock ticks on the device itself — SPARC R4 "native home wins"). No render().
export function makeClockPanel({ dwellMs = 15000 } = {}) {
  return {
    id: 'clock',
    page: 'home',
    dwellMs,
    async poll() {},
    available() { return true; },
    stale() { return false; },
  };
}
