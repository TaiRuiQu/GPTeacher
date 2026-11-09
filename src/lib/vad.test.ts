import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad } from './vad.ts';
import { toSpeechText, looksLikePlaybackEcho } from './speech.ts';

const sound = (amplitude: number) => new Float32Array(2048).fill(amplitude);
test('VAD ignores quiet background and short impulses, then closes a real utterance after silence', () => {
  const vad = new EnergyVad();
  for (let time = 1; time < 500; time += 20)
    assert.equal(vad.process(sound(0.003), time).speaking, false);
  assert.equal(vad.process(sound(0.08), 501).started, false);
  assert.equal(vad.process(sound(0.003), 521).speaking, false);
  assert.equal(vad.process(sound(0.08), 601).started, false);
  assert.equal(vad.process(sound(0.09), 721).started, true);
  assert.equal(vad.process(sound(0.003), 800).ended, false);
  assert.equal(vad.process(sound(0.003), 1700).ended, false);
  assert.equal(vad.process(sound(0.003), 1801).ended, true);
  assert.equal(vad.process(sound(0.003), 1900).speaking, false);
});
test('VAD reset clears an active speech turn', () => {
  const vad = new EnergyVad();
  vad.process(sound(0.1), 1);
  assert.equal(vad.process(sound(0.1), 140).speaking, true);
  vad.reset();
  assert.equal(vad.process(sound(0), 150).speaking, false);
});
test('plain speech text retains lesson meaning and has deterministic offsets without markup', () => {
  const text = toSpeechText(
    '## 理解等式\n\n**两边相等**。看 [例子](https://example.com)。\n\n```svg\n<svg/>\n```',
  );
  assert.equal(text, '理解等式。\n两边相等。看 例子。。');
  assert.equal(text.includes('https'), false);
  const offset = text.indexOf('两边');
  assert.equal(text.slice(0, offset), '理解等式。\n');
});
test('playback echo suppression rejects matching narration but permits a new student question', () => {
  const narration = '等式两边同时减去三，得到 x 等于四。';
  assert.equal(looksLikePlaybackEcho('等式两边同时减去三', narration), true);
  assert.equal(looksLikePlaybackEcho('为什么要两边同时减去三？', narration), false);
});
