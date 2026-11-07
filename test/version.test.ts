import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TOOL_VERSION } from '../src/version.ts';

test('the CLI reports the version in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(TOOL_VERSION, pkg.version);
});
