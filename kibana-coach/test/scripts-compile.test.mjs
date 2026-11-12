// Every script the gateway injects into Kibana must at least compile: they are plain browser scripts with
// no build step, and one that fails to parse silently drops its part of the coach (an application
// adapter, say, leaving its steps "Unsupported"). Run with: node --test kibana-coach/test/*.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = new URL('../src/', import.meta.url);
const gateway = fs.readFileSync(new URL('../../kibana-gateway/nginx.conf', import.meta.url), 'utf8');
const injected = [...gateway.matchAll(/\/incident-coach\/assets\/(src\/[\w/.-]+\.js)/g)].map(match => match[1]);

test('the gateway injects every coach script, and each one compiles', () => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(source.pathname);
  assert.ok(injected.length >= 10, 'the gateway names the coach scripts it injects');
  for (const script of injected) assert.ok(fs.existsSync(new URL(`../${script}`, import.meta.url)), `${script} is injected but missing`);
  for (const file of files) {
    const relative = path.relative(new URL('..', import.meta.url).pathname, file);
    assert.ok(injected.includes(relative), `${relative} is never injected into Kibana`);
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), {filename: relative}), `${relative} does not compile`);
  }
});
