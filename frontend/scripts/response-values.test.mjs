import assert from 'node:assert/strict';
import test from 'node:test';
import { asArray, asRecord, finiteNumber, nonBlankText, textOr } from '../src/core/api/response-values.ts';

test('response readers keep arrays and records distinct', () => {
  const record = { quantity: 0 };
  const array = [record];
  assert.equal(asRecord(record), record);
  assert.deepEqual(asRecord(array), {});
  assert.deepEqual(asRecord(null), {});
  assert.deepEqual(asRecord('quantity'), {});
  assert.equal(asArray(array), array);
  assert.deepEqual(asArray(record), []);
  assert.deepEqual(asArray(undefined), []);
});

test('text readers preserve spacing in non-blank values and use explicit fallbacks', () => {
  assert.equal(nonBlankText(' A-01 '), ' A-01 ');
  assert.equal(nonBlankText('  '), null);
  assert.equal(nonBlankText(0), null);
  assert.equal(textOr('', 'Unassigned'), 'Unassigned');
  assert.equal(textOr(undefined, ''), '');
  assert.equal(textOr('0', 'Unknown'), '0');
});

test('a strict numeric response reader distinguishes zero from missing and textual values', () => {
  assert.equal(finiteNumber(0), 0);
  assert.equal(finiteNumber(-12.5), -12.5);
  for (const value of ['0', '12.5', '', null, undefined, false, Infinity, NaN]) {
    assert.equal(finiteNumber(value), null);
  }
});
