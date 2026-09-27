// OWNER: UI-B (Train). Contract (docs/UI_GUIDE.md §6).
// Sheets and data helpers load on demand so screens that only import these actions stay light.
const load = () => Promise.all([import('../parts/train-data.js'), import('../parts/train-sheets.js')]);

/**
 * startWorkout(app, { date, templateId }) → Promise<string|undefined> (session id; navigates to #/train/session/<id>)
 * Resumes the date's open session (no endAt); else starts from `templateId`; else asks: template, repeat a recent
 * session, or an empty session. Template sessions pre-fill set counts and rep targets, weights from last time.
 */
export async function startWorkout(app, { date, templateId } = {}) {
  try {
    const d = date || app.today();
    const [data, sheets] = await load();
    const open = data.openSessionOn(app.dv, d);
    if (open) { app.nav('/train/session/' + open.id); return open.id; }
    const choice = templateId && app.store.get('templates', templateId) ? { kind: 'template', id: templateId } : await sheets.chooseStart(app, { date: d });
    if (!choice) return undefined;
    if (choice.kind === 'open') { app.nav('/train/session/' + choice.id); return choice.id; }
    const id = sheets.createFromChoice(app, choice, d);
    if (!id) { app.toast('That template or session no longer exists.'); return undefined; }
    app.nav('/train/session/' + id);
    return id;
  } catch (e) {
    console.warn('[train] startWorkout', e);
    app.toast('Could not start the workout.', { tone: 'error' });
    return undefined;
  }
}

/**
 * openCardioLog(app, { date }) → Promise<string|undefined> (session id)
 * Exercise (defaults to the most recently used cardio exercise), duration, distance, avg watts, avg/max HR, kcal,
 * RPE and start time. Appends to the date's open session, otherwise creates a finished session.
 */
export async function openCardioLog(app, { date } = {}) {
  try {
    const [, sheets] = await load();
    return await sheets.cardioSheet(app, { date: date || app.today() });
  } catch (e) {
    console.warn('[train] openCardioLog', e);
    app.toast('Could not open the cardio log.', { tone: 'error' });
    return undefined;
  }
}
