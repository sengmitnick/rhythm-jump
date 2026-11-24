// Runtime configuration entry point.
//
// The real values live in service-config.local.js, which is git-ignored so that
// a personal Lingzhu bot ID never lands in the public repository. Run
// `npm run config:init` to create it from config/service-config.example.js.
//
// An empty agentId keeps the leaderboard offline; local scores still save.
export { SERVICE_CONFIG } from './service-config.local.js';
