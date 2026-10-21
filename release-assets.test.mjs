import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VERSION} from './bridge.mjs';
import {RUNTIME_FILES} from './service-manager.mjs';

test('branded extension ships transparent PNGs in every advertised icon size and keeps release versions aligned', async () => {
  const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'X 评论助手');
  assert.equal(manifest.short_name, 'X 评论助手');
  assert.equal(manifest.version, VERSION);
  assert.equal(pkg.version, VERSION);
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  for (const size of [16,32,48,128]) {
    const file = manifest.icons[size];
    const bytes = await readFile(new URL('extension/'+file, import.meta.url));
    assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    assert.equal(bytes[25], 6, 'RGBA PNG preserves the generated transparent background');
    assert.ok(RUNTIME_FILES.includes('extension/'+file));
  }
});

test('runtime includes the prompt dependency and only packaged icon paths appear in the panel', async () => {
  assert.ok(RUNTIME_FILES.includes('reply-expertise.js'));
  const html = await readFile(new URL('extension/panel.html', import.meta.url), 'utf8');
  const images = [...html.matchAll(/(?:src|href)="(icons\/[^"]+)"/gu)].map(match=>match[1]);
  assert.ok(images.length);
  for (const file of images) {
    assert.match(file, /^icons\/icon-(?:32|128)\.png$/u);
    await readFile(new URL('extension/'+file, import.meta.url));
  }
});
