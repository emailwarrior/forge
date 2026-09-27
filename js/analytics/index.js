// FORGE analytics — single entry point. Pure functions over a DataView (see docs/ANALYTICS_API.md).
// `adherence` exists in both nutrition.js and protocols.js; use the aliases
// nutritionAdherence / protocolAdherence or the `nutrition` / `protocols` namespaces.
export * from './dataview.js';
export * from './stats.js';
export * from './daily.js';
export * from './readiness.js';
export * from './execution.js';
export * from './body.js';
export * from './strength.js';
export * from './labs.js';
export * from './schedule.js';
export * from './correlations.js';
export * from './weekly.js';
export * from './finance.js';
export * from './context.js';
export { sumNutrients, dayNutrition, microSummary, MICRO_REFERENCES, adherence as nutritionAdherence } from './nutrition.js';
export {
  inWindow, doseDates, takenOn, lastDoseOnOrBefore, isDue, dueItems, stackStatus, nextDue, toMg,
  daysSinceDose, doseMgOn, kindAdherenceOn, doseCycle, adherence as protocolAdherence,
} from './protocols.js';
export * as nutrition from './nutrition.js';
export * as protocols from './protocols.js';
export * as stats from './stats.js';
