/**
 * What a queued project is told.
 *
 * Before the render cap, five projects were admitted at once and the last one
 * spent 15m10s between its final chunk and its video. On screen that was
 * indistinguishable from a hang: status "queued", nothing moving, no reason.
 * The cap makes the wait shorter and ordered; these tests pin the part that
 * makes it bearable, which is being told about it honestly.
 *
 * The rule under test throughout: an estimate is always labelled as one, and a
 * number we do not have is never invented.
 */
import { describe, expect, it } from "vitest";
import { describeQueuePosition, describeWait } from "../render-queue";

describe("describeWait", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeWait(null)).toBeNull();
    expect(describeWait(undefined)).toBeNull();
    expect(describeWait(0)).toBeNull();
    expect(describeWait(-30)).toBeNull();
    expect(describeWait(Number.NaN)).toBeNull();
  });

  it("does not quote seconds", () => {
    expect(describeWait(20)).toBe("under a minute");
    expect(describeWait(59)).toBe("under a minute");
  });

  it("keeps single minutes while they are still informative", () => {
    expect(describeWait(60)).toBe("about 1 minute");
    expect(describeWait(8 * 60)).toBe("about 8 minutes");
  });

  it("rounds to five minutes past a quarter hour", () => {
    // "about 37 minutes" implies a precision a median-based estimate does not
    // have, and invites the user to time it.
    expect(describeWait(37 * 60)).toBe("about 35 minutes");
    expect(describeWait(38 * 60)).toBe("about 40 minutes");
  });

  it("switches to half hours past an hour", () => {
    expect(describeWait(3600)).toBe("about 1 hour");
    expect(describeWait(75 * 60)).toBe("about 1.5 hours");
    expect(describeWait(2 * 3600)).toBe("about 2 hours");
  });
});

describe("describeQueuePosition", () => {
  it("says nothing for a project that is not waiting", () => {
    expect(describeQueuePosition(null, 600)).toBeNull();
    expect(describeQueuePosition(0, 600)).toBeNull();
    expect(describeQueuePosition(undefined, undefined)).toBeNull();
  });

  it("gives the position and a labelled estimate", () => {
    const text = describeQueuePosition(3, 40 * 60);
    expect(text).toContain("Position 3");
    expect(text).toContain("about 40 minutes");
    // The label is the point. Without it this is a promise, not an estimate.
    expect(text).toContain("(estimate)");
  });

  it("tells the next project it is next", () => {
    const text = describeQueuePosition(1, 5 * 60);
    expect(text).toContain("Next in line");
    expect(text).not.toContain("Position 1");
  });

  it("still explains the wait when nothing has been measured yet", () => {
    // A fresh worker has timed no chunks. Saying where they are without
    // guessing when beats both silence and a fabricated number.
    const text = describeQueuePosition(2, null);
    expect(text).toContain("Position 2");
    expect(text).not.toContain("estimate");
    expect(text).toContain("ahead");
  });
});
