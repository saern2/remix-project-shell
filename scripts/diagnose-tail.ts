/**
 * Reports why a rendered video is longer than its narration.
 *
 *   npx tsx scripts/diagnose-tail.ts <project-id>
 *
 * Prints the five facts needed to decide whether a tail is a defect or the
 * pipeline faithfully covering an audio file that keeps going after the last
 * word:
 *
 *   1. measured audio duration (what the ASR reported for the file)
 *   2. sum of scene durations, and the last scene's end_ts
 *   3. the rendered video's timeline duration
 *   4. what occupies the tail — which clips, and whether any freeze
 *   5. trailing silence: the gap between the last transcribed word and the
 *      end of the audio file
 *
 * Read-only. Needs the same SUPABASE_URL and service-role key as the server.
 */
import { buildExpectedSliceSlots, buildSceneTimelineSlots } from "../src/lib/clip-slices.server";

const projectId = process.argv[2];
if (!projectId) {
  console.error("Usage: npx tsx scripts/diagnose-tail.ts <project-id>");
  process.exit(1);
}

const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");

const { data: project } = await supabaseAdmin
  .from("projects")
  .select("id, name, clip_duration_seconds, status")
  .eq("id", projectId)
  .maybeSingle();
if (!project) {
  console.error(`No project ${projectId}.`);
  process.exit(1);
}

const [{ data: scenes }, { data: audio }, { data: transcript }, { data: slices }] =
  await Promise.all([
    supabaseAdmin
      .from("scenes")
      .select("id, idx, start_ts, end_ts, text")
      .eq("project_id", projectId)
      .order("idx", { ascending: true }),
    supabaseAdmin
      .from("audio_assets")
      .select("duration_sec, filename")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("transcripts")
      .select("word_timestamps")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("render_clip_slices")
      .select(
        "scene_id, slice_index, timeline_start_seconds, timeline_end_seconds, provider_clip_id",
      )
      .eq("project_id", projectId),
  ]);

const sceneRows = scenes ?? [];
if (sceneRows.length === 0) {
  console.error("Project has no scenes.");
  process.exit(1);
}

const measuredAudioDuration = Number(audio?.duration_sec);
const narrationEnd = Math.max(...sceneRows.map((s) => Number(s.end_ts ?? 0)));
// Exactly the expression the pipeline uses, so the numbers below are the ones
// the render actually saw rather than a re-derivation that could drift.
const audioDuration =
  Number.isFinite(measuredAudioDuration) && measuredAudioDuration > 0
    ? Math.max(measuredAudioDuration, narrationEnd)
    : narrationEnd;

const sceneSpanSum = sceneRows.reduce(
  (total, s) => total + Math.max(0, Number(s.end_ts ?? 0) - Number(s.start_ts ?? 0)),
  0,
);

const fixedDuration =
  project.clip_duration_seconds != null ? Number(project.clip_duration_seconds) : null;
const slots =
  fixedDuration != null && fixedDuration > 0
    ? buildExpectedSliceSlots(sceneRows, fixedDuration, audioDuration)
    : buildSceneTimelineSlots(sceneRows, audioDuration);

const timelineEnd = slots.length > 0 ? Math.max(...slots.map((s) => s.timelineEnd)) : 0;

// Anything after the last spoken word is the tail under investigation.
const words = Array.isArray(transcript?.word_timestamps)
  ? (transcript.word_timestamps as Array<{ end?: number; text?: string; word?: string }>)
  : [];
const lastWord = words.length > 0 ? words[words.length - 1] : null;
// AssemblyAI reports word times in milliseconds; anything above the file
// duration is therefore ms and needs scaling.
const lastWordEndRaw = Number(lastWord?.end ?? NaN);
const lastWordEndSec = Number.isFinite(lastWordEndRaw)
  ? lastWordEndRaw > audioDuration * 2
    ? lastWordEndRaw / 1000
    : lastWordEndRaw
  : null;

const tailStart = narrationEnd;
const tailSlots = slots.filter((slot) => slot.timelineEnd > tailStart + 0.001);
const sliceByKey = new Map((slices ?? []).map((s) => [`${s.scene_id}:${s.slice_index}`, s]));

console.log(
  JSON.stringify(
    {
      project: { id: project.id, name: project.name, status: project.status },
      mode: fixedDuration ? `fixed-duration (${fixedDuration}s slices)` : "one clip per scene",

      audio: {
        filename: audio?.filename ?? null,
        measuredDurationSec: Number.isFinite(measuredAudioDuration) ? measuredAudioDuration : null,
        durationUsedByPipelineSec: Number(audioDuration.toFixed(3)),
      },

      scenes: {
        count: sceneRows.length,
        sumOfSceneDurationsSec: Number(sceneSpanSum.toFixed(3)),
        firstSceneStartSec: Number(Number(sceneRows[0].start_ts ?? 0).toFixed(3)),
        lastSceneEndSec: Number(narrationEnd.toFixed(3)),
        lastSceneText: sceneRows[sceneRows.length - 1].text?.slice(0, 80) ?? null,
      },

      video: {
        timelineDurationSec: Number(timelineEnd.toFixed(3)),
        // If this is not ~0 the scenes do NOT tile the audio, which would be a
        // real defect rather than a trailing-silence question.
        coverageGapSec: Number((audioDuration - timelineEnd).toFixed(3)),
      },

      tail: {
        startsAtSec: Number(tailStart.toFixed(3)),
        lengthSec: Number((timelineEnd - tailStart).toFixed(3)),
        slotCount: tailSlots.length,
        occupiedBy: tailSlots.slice(0, 20).map((slot) => {
          const key = `${slot.sceneId}:${"sliceIndex" in slot ? slot.sliceIndex : 0}`;
          return {
            sceneIdx: slot.sceneIdx,
            sliceIndex: "sliceIndex" in slot ? slot.sliceIndex : 0,
            fromSec: Number(slot.timelineStart.toFixed(3)),
            toSec: Number(slot.timelineEnd.toFixed(3)),
            providerClipId: sliceByKey.get(key)?.provider_clip_id ?? "(one clip per scene)",
          };
        }),
      },

      trailingSilence: {
        lastTranscribedWord: lastWord ? (lastWord.text ?? lastWord.word ?? null) : null,
        lastWordEndSec: lastWordEndSec == null ? null : Number(lastWordEndSec.toFixed(3)),
        silenceAfterLastWordSec:
          lastWordEndSec == null ? null : Number((audioDuration - lastWordEndSec).toFixed(3)),
      },
    },
    null,
    2,
  ),
);
