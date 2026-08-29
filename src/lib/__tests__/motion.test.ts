import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTROUTER_SIGNUP_URL,
  describeMotionStage,
  keyTail,
  MOTION_DURATION_COPY,
  MOTION_KEY_COPY,
  MOTION_MODELS,
  MOTION_STALE_AFTER_HOURS,
  motionJobId,
  motionPollVerdict,
  motionStoragePath,
} from "@/lib/motion/motion";

const HOUR_MS = 60 * 60 * 1000;

describe("the mandated key copy (Item 4 + D10), pinned verbatim", () => {
  it("carries the operator's block character for character", () => {
    expect(MOTION_KEY_COPY.intro).toBe(
      "You'll need your own API key. Motion explainers are generated using your own AI provider account, so you control the cost.",
    );
    expect(MOTION_KEY_COPY.linkLabel).toBe("Get a free AgentRouter key →");
    expect(MOTION_KEY_COPY.steps).toBe(
      "Sign up, open API Token, create a token, and paste it below. Your key is encrypted and never shown again.",
    );
    expect(MOTION_KEY_COPY.claudeBatches).toBe(
      "Claude models are released in daily batches and may be temporarily unavailable — if that happens, choose GLM or DeepSeek instead. Both are verified working.",
    );
  });

  it("D10: the referral disclosure sits with the link", () => {
    expect(MOTION_KEY_COPY.referralDisclosure).toBe(
      "We may earn a referral credit if you sign up through this link.",
    );
  });

  it("D10: the duration copy states the real shape and the tab-close truth", () => {
    expect(MOTION_DURATION_COPY).toContain("30–60 minutes");
    expect(MOTION_DURATION_COPY).toContain("close this tab");
  });

  it("the model ids are the operator-confirmed AgentRouter identifiers, verbatim", () => {
    // The worker passes the id through to the provider unchanged, so a wrong
    // string is a failed job. deepseek-v4-flash is the id that ran the
    // successful 28 Aug job (v3.2 was never verified against the account).
    expect(MOTION_MODELS.map((m) => m.id)).toEqual([
      "glm-5.3",
      "deepseek-v4-flash",
      "claude-opus-5",
      "claude-opus-4-8",
    ]);
  });

  it("the model list labels Claude's batch availability and names the verified pair", () => {
    const labels = MOTION_MODELS.map((m) => m.label).join(" | ");
    expect(labels).toContain("verified working");
    expect(labels).toContain("may be unavailable");
    expect(MOTION_MODELS[0].id).not.toContain("claude"); // a verified model is the default
  });

  it("the signup link is the referral URL, so the disclosure line is true", () => {
    expect(AGENTROUTER_SIGNUP_URL).toBe("https://agentrouter.org/register?aff=sF1j");
  });
});

describe("motionPollVerdict — failure honesty at read time (Item 3)", () => {
  const entered = new Date("2026-08-29T12:00:00Z").toISOString();
  const fresh = Date.parse(entered) + HOUR_MS;
  const stale = Date.parse(entered) + (MOTION_STALE_AFTER_HOURS + 1) * HOUR_MS;

  it("worker-lost fails honestly; a moved-on project needs nothing", () => {
    expect(
      motionPollVerdict({
        projectStatus: "generating_motion",
        stateEnteredAtIso: entered,
        nowMs: fresh,
        worker: { kind: "not-found" },
      }),
    ).toMatchObject({ action: "fail" });
    expect(
      motionPollVerdict({
        projectStatus: "completed",
        stateEnteredAtIso: entered,
        nowMs: fresh,
        worker: { kind: "not-found" },
      }),
    ).toEqual({ action: "moved-on" });
  });

  it("a worker failure passes its worded reason through — the 402 story intact", () => {
    const verdict = motionPollVerdict({
      projectStatus: "generating_motion",
      stateEnteredAtIso: entered,
      nowMs: fresh,
      worker: {
        kind: "ok",
        payload: {
          status: "failed",
          error: "Your AI provider account is out of credit… choose GLM or DeepSeek instead.",
        },
      },
    });
    expect(verdict.action).toBe("fail");
    if (verdict.action === "fail") expect(verdict.message).toContain("GLM or DeepSeek");
  });

  it("the whole-state ceiling: stale queued fails, but a ready result completes even past it", () => {
    expect(MOTION_STALE_AFTER_HOURS).toBe(8);
    expect(
      motionPollVerdict({
        projectStatus: "generating_motion",
        stateEnteredAtIso: entered,
        nowMs: stale,
        worker: { kind: "ok", payload: { status: "queued" } },
      }),
    ).toMatchObject({ action: "fail" });
    expect(
      motionPollVerdict({
        projectStatus: "generating_motion",
        stateEnteredAtIso: entered,
        nowMs: stale,
        worker: { kind: "ok", payload: { status: "completed" } },
      }),
    ).toEqual({ action: "complete" });
  });

  it("otherwise waits, carrying the payload for the stage line", () => {
    expect(
      motionPollVerdict({
        projectStatus: "generating_motion",
        stateEnteredAtIso: entered,
        nowMs: fresh,
        worker: { kind: "ok", payload: { status: "processing", progress_pct: 40 } },
      }),
    ).toMatchObject({ action: "wait" });
  });
});

describe("stage lines — measured ETA, labelled as such", () => {
  it("queued names position and the measured-jobs source", () => {
    const line = describeMotionStage({ status: "queued", queue_position: 2, eta_seconds: 5078 });
    expect(line).toContain("position 2 in line");
    expect(line).toContain("about 85 min");
    expect(line).toContain("from measured jobs");
  });

  it("processing carries the duration truth and the tab-close truth", () => {
    const line = describeMotionStage({ status: "processing", progress_pct: 37 });
    expect(line).toContain("37%");
    expect(line).toContain("30–60 minutes");
    expect(line).toContain("close this tab");
  });
});

describe("contract constants", () => {
  it("job id and storage path are deterministic; the path matches pollRenderJob's re-sign convention", () => {
    expect(motionJobId("p-1")).toBe("motion-p-1");
    // `${project_id}/${render_job_id}.mp4` — the exact path the existing
    // completed-render short-circuit re-signs for playback.
    expect(motionStoragePath("p-1", "rj-9")).toBe("p-1/rj-9.mp4");
  });

  it("keyTail exposes four characters at most", () => {
    expect(keyTail("sk-abcdef-x4Kd")).toBe("x4Kd");
    expect(keyTail("ab")).toBe("");
  });
});

describe("ceiling sharing (Item 4) — one bound, both directions", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/motion/motion.functions.ts"),
    "utf8",
  );

  it("a motion submission creates an ordinary queued render_jobs row, so Round A's count sees it", () => {
    expect(source).toContain('from("render_jobs")');
    expect(source).toContain('status: "queued"');
    expect(source).toContain('mode: "motion"');
  });

  it("and runs the same Round A count itself, with render-inflight.ts untouched (imported, not modified)", () => {
    expect(source).toContain('from "@/lib/render-inflight"');
    expect(source).toContain("INFLIGHT_RENDER_STATUSES");
    expect(source).toContain("inflightRefusalMessage");
  });

  it("the plaintext key never reaches a log call in the app server fns", () => {
    // Every console.* line in the file is checked for the decrypted value's
    // identifiers; the decrypt result is used exactly once, in the POST body.
    const consoleLines = source.split("\n").filter((line) => line.includes("console."));
    for (const line of consoleLines) {
      expect(line).not.toMatch(/api_key|decryptProviderKey|plaintext|keyRow/);
    }
    expect(source.match(/decryptProviderKey\(keyRow\.ciphertext\)/g)).toHaveLength(1);
  });
});
