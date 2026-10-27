import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerKeyMismatch,
  localVerdict,
  solutionFinal,
} from '../src/lib/mathcheck.js';

const clock = {
  id: 'q_clock',
  answer: { latex: '\\frac{5\\pi}{3}', value: 5.235987755982989 },
  solution: [
    'The minute hand moves through an angle of $\\frac{360}{60}\\times25=150$ degrees in 25 minutes.',
    'Convert the angle to radians: $150^\\circ=\\frac{150\\pi}{180}=\\frac{5\\pi}{6}$ radians.',
    'Then, the arc length is calculated using $L=r\\theta=6\\times\\frac{5\\pi}{6}=5\\pi$ inches.',
  ],
};

test('reads the final value from the worked solution', () => {
  assert.equal(solutionFinal(clock), '5\\pi');
  assert.equal(solutionFinal({ solution: ['Therefore $x=\\boxed{4}$.'] }), '4');
  assert.equal(solutionFinal({ solution: ['$L=6\\times\\frac{5\\pi}{6}=5\\pi$ inches.'] }), '5\\pi');
  assert.equal(solutionFinal({ solution: ['So $x=2$ or $x=3$.'] }), '3');
});

test('detects a numerically inconsistent answer key', () => {
  const mismatch = answerKeyMismatch(clock);
  assert.ok(mismatch);
  assert.equal(mismatch.latex, '5\\pi');
  assert.ok(Math.abs(mismatch.value - 5 * Math.PI) < 1e-9);
});

test('accepts the student when they match the worked solution', () => {
  const result = localVerdict(clock, '5\\pi');
  assert.equal(result.verdict, 'correct');
  assert.equal(result.matchedAlternate, true);
  assert.match(result.detail, /worked solution/i);
});

test('still accepts the stored key when it is a valid equivalent', () => {
  assert.equal(localVerdict(clock, '\\frac{5\\pi}{3}').verdict, 'correct');
});

test('does not call a wrong answer incorrect when the key is broken', () => {
  assert.equal(localVerdict(clock, '3\\pi').verdict, 'review');
});

test('consistent questions still grade normally', () => {
  const clean = {
    id: 'q_clean',
    answer: { latex: '2' },
    solution: ['Subtract $4$ from both sides: $x=2$.'],
  };
  assert.equal(answerKeyMismatch(clean), null);
  assert.equal(localVerdict(clean, '2').verdict, 'correct');
  assert.equal(localVerdict(clean, '3').verdict, 'incorrect');
  assert.equal(localVerdict(clean, '').verdict, 'blank');
});
