import { readResearchLogs } from './research-log.js';

// Turns the stored research runs into the same JSON rows the export page emits,
// so the game can hand its own log over without navigating to another page.
// Every row is a `[rhythm-research] {...}` line the desktop collector already
// understands.
export const RESEARCH_MARKER = '[rhythm-research] ';

export function researchExportRows(storage, { exportId, maxRuns = 3 } = {}) {
  const archive = readResearchLogs(storage);
  if (archive.indexError) throw new Error(archive.indexError);
  const id = exportId || `run-${Date.now().toString(36)}`;
  const rows = [{ schemaVersion: 1, exportId: id, kind: 'begin', runCount: Math.min(archive.runs.length, maxRuns) }];
  let eventCount = 0;
  for (const run of archive.runs.slice(0, maxRuns)) {
    const { id: runId, records, meta, status, reason, endedAtMs, ...rest } = run;
    rows.push({ schemaVersion: 1, exportId: id, kind: 'run', runId, ...rest, meta, status, reason, endedAtMs, records: records.length });
    for (const record of records) {
      rows.push({ schemaVersion: 1, exportId: id, kind: 'event', runId, event: record });
      eventCount++;
    }
  }
  rows.push({ schemaVersion: 1, exportId: id, kind: 'end', runCount: Math.min(archive.runs.length, maxRuns), eventCount });
  return { exportId: id, runCount: Math.min(archive.runs.length, maxRuns), eventCount, rows };
}

export function researchExportLines(storage, options) {
  const { rows } = researchExportRows(storage, options);
  return rows.map(row => RESEARCH_MARKER + JSON.stringify(row));
}
