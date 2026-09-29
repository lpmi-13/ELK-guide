import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function loadClass(path, name) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  return new Function(`${source}\nreturn ${name};`)();
}

test('guided debrief shows the scored percentage, phase credit, and marked gradient bar', () => {
  const Debrief = loadClass('../src/ui/debrief.js', 'IncidentDebrief');
  const Panel = loadClass('../src/ui/coach-panel.js', 'IncidentCoachPanel');
  const dialog = {
    innerHTML: '',
    querySelector: () => ({textContent: ''}),
    addEventListener() {},
    showModal() {},
  };
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: () => dialog};
  try {
    new Debrief({append() {}}).show({
      scored: true,
      total: 70,
      summary: 'Complete.',
      assistance: {step_count: 5, independent_steps: 3, hints: 1, hinted_steps: 1, demonstrated_steps: 1, shown_steps: 1},
    });
    assert.match(dialog.innerHTML, /Guided practice score<\/strong><strong>70%/);
    assert.match(dialog.innerHTML, /role="progressbar"[^>]*aria-valuenow="70"[^>]*--score:70%/);
    assert.match(dialog.innerHTML, /Per phase: 20% without help · 10% with hints only · 0% with Show me/);
    assert.equal((dialog.innerHTML.match(/<i><\/i>/g) || []).length, 6);
    assert.match(dialog.innerHTML, /<span>0%<\/span>.*<span>100%<\/span>/);
    assert.match(Panel.styles, /guided-score-track[^}]*linear-gradient\(90deg/);
    assert.match(Panel.styles, /guided-score-unearned[^}]*left:var\(--score\)/);
  } finally {
    globalThis.document = originalDocument;
  }
});
