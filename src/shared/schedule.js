// The renderer cannot import from src/engine (it would pull Node code into the UI), so the few
// pure schedule helpers the UI needs are re-exported from here. engine/schedule.js has no Node imports.
export { DAY_NAMES, describeTrigger, parseTime, nextRun } from '../engine/schedule.js'
