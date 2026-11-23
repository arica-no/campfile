import { expect, it } from 'vitest';
import { newKey, newPageId, newState, readSignedId, sha256Hex, signedId, STATE } from '../src/keys.ts';

it('hashes with SHA-256 (standard test vector)', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it('makes 64-character hex keys that differ every time', () => {
  expect(newKey()).toMatch(/^[0-9a-f]{64}$/);
  expect(newKey()).not.toBe(newKey());
});

it('makes page ids of 8 characters from [A-Za-z0-9]', () => {
  const ids = Array.from({ length: 2000 }, newPageId);
  expect(ids.every((id) => /^[A-Za-z0-9]{8}$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it('makes login states that the app accepts and that differ every time', () => {
  const states = Array.from({ length: 200 }, newState);
  expect(states.every((state) => STATE.test(state))).toBe(true);
  expect(new Set(states).size).toBe(states.length);
});

it('refuses to sign without a secret', async () => {
  await expect(signedId('', 'owner', 7, 1000)).rejects.toThrow();
});

it('accepts a signed id only for its own id and scope, unchanged and unexpired', async () => {
  const later = Math.floor(Date.now() / 1000) + 60;
  const cookie = await signedId('a secret', 'session', 7, later);
  expect(await readSignedId('a secret', 'session', cookie)).toBe(7);
  expect(await readSignedId('another secret', 'session', cookie)).toBeUndefined();
  expect(await readSignedId('a secret', 'access:AAAAAAAA', cookie)).toBeUndefined(); // a session cookie is no visitor pass
  expect(await readSignedId('a secret', 'session', cookie.replace(/^7\./, '8.'))).toBeUndefined();
  expect(await readSignedId('a secret', 'session', await signedId('a secret', 'session', 7, Math.floor(Date.now() / 1000) - 1))).toBeUndefined();
  for (const broken of [undefined, '', '7', '7.x.y', `7.${later}`]) expect(await readSignedId('a secret', 'session', broken), String(broken)).toBeUndefined();
});
