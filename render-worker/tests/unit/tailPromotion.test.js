'use strict';

/**
 * Tail starvation, second attempt — the first one made it worse.
 *
 * Chunk priority is static: a project on its LAST chunks holds the highest
 * indices in the system, so every newer project's early chunks outrank it. The
 * closer a project gets to done, the worse it competes, while it holds an
 * admission slot nothing else can use.
 *
 * THE FIRST FIX PROMOTED INTO THE INDEX-0 BAND, level with other projects'
 * first chunks, on the reasoning that absolute preemption "would just move the
 * starvation". The five-project run measured what that reasoning cost:
 *
 *   22nd project (47 chunks): ran to chunk 40, then a 19-MINUTE gap
 *   23rd project (48 chunks): ran to chunk 40, then 21.6 MINUTES, unfinished
 *
 * while two freshly-admitted projects raced through 40+ chunks each. Level with
 * index 0 means a promoted chunk in slot 2 loses to every fresh project holding
 * slots 0 and 1 — a project at 85% was made to compete against a fresh
 * project's entire workload and lost. The band has to be ABOVE index 0.
 *
 * These tests pin the new band, and the two bounds that stop "finish what is
 * nearly done" from becoming "starve everything else".
 */
// vitest globals are enabled for the worker suite; see vitest.config.js.
const {
  chunkPriority,
  shouldPromoteTail,
  tailPriority,
  maxTailBandChunks,
  TAIL_COMPLETION_FRACTION,
  TAIL_CHUNK_WINDOW,
} = require('../../src/fairScheduling');

const STRIDE = 1000;

describe('the boosted band sits ABOVE every regular chunk', () => {
  it('beats another project’s FIRST chunk, which is the whole fix', () => {
    // The exact comparison the old behaviour lost. Lower is sooner in BullMQ.
    const promotedWorstSlot = tailPriority(999, STRIDE);
    const freshBestSlot = chunkPriority(0, 0, STRIDE);
    expect(promotedWorstSlot).toBeLessThan(freshBestSlot);
  });

  it('beats every chunk index at every slot', () => {
    const promoted = tailPriority(3, STRIDE);
    for (const index of [0, 1, 2, 10, 40, 100]) {
      for (const slot of [0, 1, 2, 5]) {
        expect(promoted).toBeLessThan(chunkPriority(index, slot, STRIDE));
      }
    }
  });

  it('is no longer chunk index 0 of the same slot', () => {
    // Pinned explicitly because that identity WAS the bug, and a future
    // simplification back to it would silently restore the 19-minute gap.
    expect(tailPriority(2, STRIDE)).not.toBe(chunkPriority(0, 2, STRIDE));
  });

  it('still round-robins between promoted projects', () => {
    // Slot is preserved inside the band, so two finishing projects interleave
    // rather than the earliest-promoted one monopolising it.
    expect(tailPriority(0, STRIDE)).toBeLessThan(tailPriority(1, STRIDE));
    expect(tailPriority(1, STRIDE)).toBeLessThan(tailPriority(2, STRIDE));
  });

  it('never emits priority 0, which BullMQ reads as unprioritised', () => {
    expect(tailPriority(0, STRIDE)).toBeGreaterThan(0);
    expect(chunkPriority(0, 0, STRIDE)).toBeGreaterThan(0);
  });

  it('tolerates a missing fairness slot', () => {
    expect(tailPriority(null, STRIDE)).toBe(tailPriority(0, STRIDE));
    expect(tailPriority(undefined, STRIDE)).toBe(tailPriority(0, STRIDE));
  });
});

describe('the regular formula still orders projects fairly', () => {
  it('keeps earlier chunk indices ahead of later ones', () => {
    expect(chunkPriority(0, 0, STRIDE)).toBeLessThan(chunkPriority(1, 0, STRIDE));
    expect(chunkPriority(5, 0, STRIDE)).toBeLessThan(chunkPriority(6, 0, STRIDE));
  });

  it('interleaves projects at the same index', () => {
    // The original fairness property, unchanged: project A's chunk 3 and
    // project B's chunk 3 are adjacent, not separated by a whole project.
    expect(chunkPriority(3, 0, STRIDE)).toBeLessThan(chunkPriority(3, 1, STRIDE));
    expect(chunkPriority(3, 1, STRIDE)).toBeLessThan(chunkPriority(4, 0, STRIDE));
  });

  it('still fits BullMQ’s range for any realistic project', () => {
    // Reserving a band costs one stride of headroom. A 2000-chunk project is
    // over six hours of video.
    expect(() => chunkPriority(2000, 999, STRIDE)).not.toThrow();
    expect(() => chunkPriority(3000, 999, STRIDE)).toThrow(/supported range/);
  });
});

describe('the two bounds on promotion', () => {
  it('promotes exactly the range that stalled on the 47-chunk project', () => {
    // Measured: it ran to chunk 40 of 47 and then stopped for 19 minutes. The
    // window is what makes those specific chunks eligible.
    expect(shouldPromoteTail(38, 47)).toBe(false);
    expect(shouldPromoteTail(39, 47)).toBe(true); // 8 remaining
    expect(shouldPromoteTail(46, 47)).toBe(true); // 1 remaining
  });

  it('caps the burst by chunk count, not just by percentage', () => {
    // 90% of a 400-chunk project is 40 chunks — promoting all of them would
    // hand one project the front of the queue for half an hour. The window
    // holds regardless of project size.
    expect(shouldPromoteTail(360, 400)).toBe(false); // 90% but 40 remaining
    expect(shouldPromoteTail(392, 400)).toBe(true); // 8 remaining
  });

  it('will not let a small project be born promoted', () => {
    // Without the completion fraction, every project with fewer than
    // TAIL_CHUNK_WINDOW chunks would be in the tail band from its first chunk
    // and would outrank everything else on the machine permanently.
    expect(shouldPromoteTail(1, 6)).toBe(false);
    expect(shouldPromoteTail(2, 6)).toBe(false);
    expect(shouldPromoteTail(5, 6)).toBe(true);
  });

  it('bounds the whole band by construction', () => {
    // With RENDER_ADMISSION_LIMIT projects admitted at once, this is the most
    // chunks that can ever sit ahead of everything else. Stated as an assertion
    // rather than a comment so the bound cannot quietly grow.
    expect(maxTailBandChunks(3)).toBe(24);
    expect(maxTailBandChunks(3)).toBe(3 * TAIL_CHUNK_WINDOW);
  });

  it('uses the thresholds it claims to', () => {
    expect(TAIL_COMPLETION_FRACTION).toBe(0.8);
    expect(TAIL_CHUNK_WINDOW).toBe(8);
  });

  it('never fires for degenerate inputs', () => {
    expect(shouldPromoteTail(0, 50)).toBe(false);
    expect(shouldPromoteTail(10, 0)).toBe(false);
    expect(shouldPromoteTail(1, 1)).toBe(false); // a 1-chunk project has no tail
    expect(shouldPromoteTail(50, 50)).toBe(false); // nothing left to promote
    expect(shouldPromoteTail(NaN, 50)).toBe(false);
    expect(shouldPromoteTail(50, NaN)).toBe(false);
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
