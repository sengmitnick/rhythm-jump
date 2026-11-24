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

  // Development receivers for local motion research. Replace with your own.
  logURLs: [
    'http://127.0.0.1:8787/log',
  ],
};
