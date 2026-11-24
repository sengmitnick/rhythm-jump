// Copy this file to src/lib/service-config.local.js, or run:
//
//   npm run config:init
//
// The local file is git-ignored, so your own Lingzhu bot ID stays out of the
// public repository. Without it the leaderboard stays offline and scores are
// still saved on the glasses.

export const SERVICE_CONFIG = {
  // Bot ID of YOUR published Lingzhu workflow. Empty keeps the leaderboard offline.
  agentId: '',

  // Developer switch for research logs, the frame meter, and motion status.
  motionDiagnostics: false,

  // With motionDiagnostics enabled, record every raw accelerometer sample.
  fullMotionTrace: false,

  // Per-device timing calibration.
  //   audioOffsetMs: how late the recording becomes audible after play(). Raise it
  //     if hits feel late on a given device; the chart waits that long before the
  //     first beat so the visible and audible downbeat agree.
  //   Keep it 0 unless a device needs it: this is calibration, not a hidden delay.
  timing: { audioOffsetMs: 0 },

  // Development receivers for local motion research. Replace with your own.
  logURLs: [
    'http://127.0.0.1:8787/log',
  ],
};
