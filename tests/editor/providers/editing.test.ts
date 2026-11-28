import assert from 'node:assert/strict';
import { test } from 'node:test';

import { languageOfUri } from '../../../editor/src/providers/editing.ts';

test('a peeked file is Blade by its .blade.php name in any case, else PHP', () => {
  assert.equal(languageOfUri('file:///w/resources/views/home.blade.php'), 'blade');
  assert.equal(languageOfUri('file:///w/resources/views/Home.BLADE.PHP'), 'blade');
  assert.equal(languageOfUri('file:///w/app/Blade.php'), 'php');
  assert.equal(languageOfUri('file:///w/app/home.blade.php.bak'), 'php');
});
