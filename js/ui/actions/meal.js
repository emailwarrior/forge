// OWNER: UI-C (Fuel). Contract: docs/UI_GUIDE.md §6.
// openMealCapture(app, { date, mode }) → Promise<string[] | undefined> (created meal ids)
//   mode 'camera' | 'library' | 'files' opens the system picker immediately (call from a tap handler), then the review
//   sheet; 'text' (describe) and 'saved' (saved foods / quick add) open their sheet; undefined opens the chooser.
//   Photos are stored encrypted, meals are created first ('analyzing', or 'pending' without an API key) and analyzed by
//   a background queue that keeps running after the sheet closes (js/ui/parts/fuel-queue.js).
// openMeal(app, id) → Promise<void> — meal detail: photos, time, items, re-analysis, follow-up, save as food, delete.
import { html } from '../../vendor/preact-htm.js';
import { isYmd } from '../../core/util.js';
import { pickFiles, PICKERS } from '../parts/fuel-ui.js';
import { CaptureSheet } from '../parts/fuel-capture.js';
import { openMeal as openMealSheet } from '../parts/fuel-meal.js';

export function openMealCapture(app, { date, mode } = {}) {
  const today = app.today();
  const day = isYmd(date) && date <= today ? date : today;
  if (mode === 'camera' || mode === 'library' || mode === 'files') {
    // The picker must open synchronously inside the caller's tap handler (iOS), so no await before this.
    return pickFiles(PICKERS[mode]).then((files) => (files.length ? openCapture(app, day, mode, files) : undefined));
  }
  return openCapture(app, day, mode === 'text' || mode === 'saved' ? mode : undefined, null);
}

function openCapture(app, date, mode, files) {
  const created = [];
  return app.sheet(({ close }) => html`<${CaptureSheet} date=${date} mode=${mode} files=${files} created=${created} close=${close} />`,
    { wide: !!(files && files.length > 1) })
    .then(() => (created.length ? [...new Set(created)] : undefined));
}

export function openMeal(app, id) { return openMealSheet(app, id); }
