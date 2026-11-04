import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPatchedVersion } from './browser-runtime.cjs';

test('reject vulnerable and unidentifiable browser versions', () => {
  for (const version of ['156.0.8078.4', '156.0.8078.78', '145.0.7632.6', '', 'Chrome/156.0.8078.80', '157.0']) {
    assert.throws(() => assertPatchedVersion(version));
  }
});
test('accept the fixed boundary and subsequent releases', () => {
  for (const version of ['156.0.8078.79', '156.0.8078.80', '157.0.8103.39']) {
    assert.doesNotThrow(() => assertPatchedVersion(version));
  }
});
