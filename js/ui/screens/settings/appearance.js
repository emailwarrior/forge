// Settings → Appearance: theme (applies immediately) and start screen.
import { html } from '../../../vendor/preact-htm.js';
import { Block, Seg, FieldGroup, useSettingDraft } from '../../parts/settings-ui.js';
import { THEMES, START_OPTIONS } from '../../parts/settings-status.js';

export default function AppearanceSection() {
  const { value: ui, set } = useSettingDraft('ui');
  return html`<div class="stack lg">
    <${Block} title="Theme">
      <${FieldGroup} hint="System follows the device’s light or dark setting. Applies on every device.">
        <${Seg} value=${ui.theme || 'system'} onValue=${(v) => set({ theme: v }, { now: true })} options=${THEMES} label="Theme" />
      </${FieldGroup}>
    </${Block}>
    <${Block} title="Start screen">
      <${FieldGroup} hint="Where FORGE opens when it starts without a specific page (the plain app address).">
        <${Seg} value=${ui.startScreen || 'today'} onValue=${(v) => set({ startScreen: v }, { now: true })} options=${START_OPTIONS} label="Start screen" />
      </${FieldGroup}>
    </${Block}>
  </div>`;
}
