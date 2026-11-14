// The gateway injects the bootstrap; it loads the remaining plain scripts only for
// active sessions. Check the entire ordered list because there is no build step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = new URL('../src/', import.meta.url);
const gateway = fs.readFileSync(new URL('../../kibana-gateway/nginx.conf', import.meta.url), 'utf8');
const bootstrap = fs.readFileSync(new URL('../src/kibana-bootstrap.js', import.meta.url), 'utf8');
const gatewayScripts = [...gateway.matchAll(/\/incident-coach\/assets\/(src\/[\w/.-]+\.js)/g)].map(match => match[1]);
const sessionScripts = [...bootstrap.matchAll(/'(src\/[\w/.-]+\.js)'/g)].map(match => match[1]);
const injected = [...gatewayScripts, ...sessionScripts];

test('the gateway and session loader cover every coach script in dependency order', () => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(source.pathname);
  assert.deepEqual(gatewayScripts, ['src/kibana-bootstrap.js']);
  assert.equal(sessionScripts.at(-1), 'src/content-script.js');
  assert.equal(new Set(injected).size, injected.length);
  for (const script of injected) assert.ok(fs.existsSync(new URL(`../${script}`, import.meta.url)), `${script} is injected but missing`);
  for (const file of files) {
    const relative = path.relative(new URL('..', import.meta.url).pathname, file);
    assert.ok(injected.includes(relative), `${relative} is never injected into Kibana`);
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), {filename: relative}), `${relative} does not compile`);
  }
});
