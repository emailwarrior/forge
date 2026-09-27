// FORGE AI layer: public entry point. See docs/AI_API.md.
import { DEFAULT_MODEL, DEFAULT_FAST_MODEL } from './claude.js';

export { AIError, AI_ERROR_CODES, isAIError, codeForStatus } from './errors.js';
export { PRICES, WEB_SEARCH_USD, priceFor, costOf, costUsd, addUsage, roundUsd, imageTokens, estimateCost } from './pricing.js';
export {
  callClaude, callClaudeJson, verifyKey, buildRequest, buildHeaders, modelCaps, isBrowser, textOf, findToolUse, parseJsonText,
  parseRetryAfter, API_URL, API_VERSION, DEFAULT_MODEL, DEFAULT_FAST_MODEL, EFFORTS, MAX_REQUEST_BYTES,
} from './claude.js';
export { analyzeMeal, analyzeMealText, mealTotals, normalizeFoodItem, scaleFoodItem, mentionsBrand, NUTRIENT_DP } from './meal.js';
export {
  extractLabs, interpretLabs, parseLabValue, parseRefRange, normalizeLabFlag, normalizeLabDate, markerOutOfRange,
} from './labs.js';
export { nutritionReview, reviewNutritionDay, weeklyReview, morningBrief, capWords } from './reviews.js';
export { askForge } from './ask.js';
export { readExifDate, timeFromFilename, prepareImage, makeThumb, preparePhoto } from './image.js';
export { GUARDRAILS, STYLE } from './prompts.js';
export {
  RECORD_MEAL_TOOL, LAB_EXTRACT_SCHEMA, LAB_INTERPRET_SCHEMA, NUTRITION_REVIEW_SCHEMA, WEEKLY_REVIEW_SCHEMA,
  CONFIDENCE, FOOD_BASIS, LAB_STATUSES, webSearchTool, schemaReport,
} from './schemas.js';

/**
 * Build the `ai` argument from settings `integrations.ai` plus the device-stored API key.
 * makeAiConfig(store.setting('integrations').ai, apiKey, { fetchImpl?, timeoutMs?, stream? })
 */
export function makeAiConfig(settingsAi, apiKey, extra = {}) {
  const s = settingsAi && typeof settingsAi === 'object' ? settingsAi : {};
  return {
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
    model: s.model || DEFAULT_MODEL,
    fastModel: s.fastModel || DEFAULT_FAST_MODEL,
    effort: s.effort || 'medium',
    webLookup: s.webLookup !== false,
    ...extra,
  };
}
