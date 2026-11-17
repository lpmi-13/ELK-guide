import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/ui/coach-panel.js', import.meta.url), 'utf8');

// A finished, explored investigation's card at (1100, 120) in a 1600×950 window: 420px tall unfolded,
// a 46px bar folded.
function exploringPanel() {
  const Panel = new Function('innerWidth', 'innerHeight', 'cancelAnimationFrame', `${source}\nreturn IncidentCoachPanel;`)(1600, 950, () => {});
  const panel = Object.create(Panel.prototype);
  let folded = false;
  const style = {maxHeight: '', setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; }};
  const fold = {hidden: true, innerHTML: '', title: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }};
  const header = {classList: {remove() {}}, hasPointerCapture: () => false};
  panel.panel = {
    hidden: false, style, offsetWidth: 0,
    classList: {toggle(name, on) { if (name === 'collapsed') folded = on; }},
    get offsetHeight() { return folded ? 46 : 420; },
  };
  panel.root = {querySelector: selector => (selector === '#fold' ? fold : header)};
  panel.completion = {mode: 'guided', until: '15:06', ended: false, exploring: true};
  panel.pos = {left: 1100, top: 120};
  panel.appliedPos = {left: 1100, top: 120};
  return {Panel, panel, style, fold};
}

test('folding the exploring coach docks it in the lower-left corner, gliding there on a cubic-bezier', () => {
  const {Panel, panel, style, fold} = exploringPanel();
  panel.setCollapsed(true);
  // 18px off the left and bottom edges: 950 - 46 - 18.
  assert.equal(style.transform, 'translate(18px, 886px)');
  assert.notEqual(style.transition, 'none', 'the move is animated, not a jump');
  assert.equal(style['--panel-ease'], Panel.dockMotion.ease);
  assert.match(Panel.dockMotion.ease, /^cubic-bezier\(/);
  // 1082 × 766 px away: the longest glide.
  assert.equal(style['--panel-move'], `${Panel.dockMotion.longest}ms`);
  assert.equal(fold.hidden, false);
  assert.equal(fold.attributes['aria-label'], 'Expand coach');
  assert.equal(fold.innerHTML, Panel.foldIcons.expand);
});

test('unfolded, the docked card rises from the bar with its bottom kept off the viewport edge', () => {
  const {Panel, panel, style, fold} = exploringPanel();
  panel.setCollapsed(true);
  panel.setCollapsed(false);
  // 950 - 420 - 18.
  assert.equal(style.transform, 'translate(18px, 512px)');
  assert.equal(style['--panel-ease'], Panel.dockMotion.ease);
  // A 374px rise: still no shorter than the dock's shortest glide.
  assert.equal(style['--panel-move'], `${Panel.dockMotion.shortest}ms`);
  assert.equal(fold.attributes['aria-label'], 'Collapse coach');
  assert.equal(fold.innerHTML, Panel.foldIcons.collapse);
});

test('the fold toggle is a drawn minus that becomes a plus', () => {
  const {Panel} = exploringPanel();
  assert.deepEqual(Panel.foldIcons.collapse.match(/ d="([^"]+)"/)[1], 'M3.5 8h9');
  assert.deepEqual(Panel.foldIcons.expand.match(/ d="([^"]+)"/)[1], 'M3.5 8h9M8 3.5v9');
});

test('a docked coach the learner drags elsewhere stays where they put it; a press alone keeps it docked', () => {
  const {panel, style} = exploringPanel();
  panel.setCollapsed(true);
  panel.keepPlace = true;
  const press = {pointerId: 1, clientX: 30, clientY: 900};
  panel.dragging = {pointerId: 1, x: 12, y: 14, width: 205, height: 46, pending: null, from: {...panel.pos}};
  panel.endDrag(press);
  assert.equal(panel.docked, true);

  panel.dragging = {pointerId: 1, x: 12, y: 14, width: 205, height: 46, pending: null, from: {...panel.pos}};
  panel.endDrag({pointerId: 1, clientX: 812, clientY: 314});
  assert.equal(panel.docked, false);
  assert.equal(style.transform, 'translate(800px, 300px)');
  // Unfolding there doesn't pull it back to the corner.
  panel.setCollapsed(false);
  assert.equal(style.transform, 'translate(800px, 300px)');
});

test('leaving the finished investigation undocks the coach', () => {
  const {panel} = exploringPanel();
  panel.setCollapsed(true);
  panel.completion = null;
  panel.setCollapsed(false);
  assert.equal(panel.docked, false);
});
