'use strict';

/**
 * Tail starvation.
 *
 * Chunk priority is static: index * stride + slot. Fair while projects are
 * mid-body, but a project on its LAST chunks holds the highest indices in the
 * system, so every newer project's early chunks outrank it — the closer a
 * project gets to done, the worse it competes, while it holds an admission slot
 * nothing else can use.
 *
 * The change under test is deliberately narrow: past 90% completion, remaining
 * chunks move to the index-0 band. The static formula is untouched; these tests
 * pin the threshold, the band arithmetic, and that the promotion actually beats
 * the priorities it needs to beat.
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const {
  chunkPriority,
  shouldPromoteTail,
  tailPriority,
  TAIL_COMPLETION_FRACTION,
} = require('../../src/fairScheduling');

const STRIDE = 1000;

describe('the promotion threshold', () => {
  it('is 90%', () => {
    expect(TAIL_COMPLETION_FRACTION).toBe(0.9);
  });

  it('fires exactly at ceil(total * 0.9) for the measured project sizes', () => {
    // The 2026-08-07 run had 39- and 51-chunk projects.
    expect(shouldPromoteTail(45, 51)).toBe(false);
    expect(shouldPromoteTail(46, 51)).toBe(true); // ceil(45.9) = 46
    expect(shouldPromoteTail(35, 39)).toBe(false);
    expect(shouldPromoteTail(36, 39)).toBe(true); // ceil(35.1) = 36
  });

  it('never fires for degenerate inputs', () => {
    expect(shouldPromoteTail(0, 50)).toBe(false);
    expect(shouldPromoteTail(10, 0)).toBe(false);
    expect(shouldPromoteTail(1, 1)).toBe(false); // a 1-chunk project has no tail
    expect(shouldPromoteTail(NaN, 50)).toBe(false);
    expect(shouldPromoteTail(50, NaN)).toBe(false);
  });
});

describe('the boosted band', () => {
  it('is exactly chunk index 0 of the same slot', () => {
    expect(tailPriority(2, STRIDE)).toBe(chunkPriority(0, 2, STRIDE));
  });

  it('outranks every other chunk index of every project', () => {
    // Lower is sooner in BullMQ. A promoted tail chunk must beat any project's
    // chunk 1 and beyond — that is the definition of not being starved.
    const promoted = tailPriority(3, STRIDE);
    for (let slot = 0; slot < 5; slot += 1) {
      expect(promoted).toBeLessThan(chunkPriority(1, slot, STRIDE));
    }
  });

  it('still round-robins with other projects FIRST chunks rather than cutting them', () => {
    // Slot preserved: the boost puts the tail level with index-0 chunks, not
    // ahead of them. Absolute preemption would just move the starvation.
    expect(tailPriority(0, STRIDE)).toBeLessThan(tailPriority(1, STRIDE));
    expect(tailPriority(1, STRIDE)).toBe(chunkPriority(0, 1, STRIDE));
  });

  it('tolerates a missing fairness slot', () => {
    expect(tailPriority(null, STRIDE)).toBe(chunkPriority(0, 0, STRIDE));
    expect(tailPriority(undefined, STRIDE)).toBe(chunkPriority(0, 0, STRIDE));
  });
});

describe('the sweep is wired to the right state', () => {
  it('reads prioritized, not waiting', () => {
    // Every chunk carries a priority, and BullMQ 5 keeps prioritised jobs in
    // their own state — a sweep over getWaiting() would silently promote
    // nothing, forever, and pass every integration test that does not assert
    // on ordering.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/queue.js'), 'utf8');
    const sweep = src.slice(
      src.indexOf('async function promoteTailChunks'),
      src.indexOf('function createWorker'),
    );
    expect(sweep).toMatch(/getPrioritized\(\)/);
    expect(sweep).not.toMatch(/getWaiting\(\)/);
    expect(sweep).toMatch(/changePriority\(\{ priority: boost \}\)/);
  });
});
