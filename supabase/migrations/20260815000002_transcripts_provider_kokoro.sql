-- Script-to-video: transcripts can now come from browser TTS.
--
-- The transcripts.provider CHECK has listed only ASR providers since the
-- base schema. TTS emits a transcript-shaped artifact through the exact same
-- persist path (persistTranscriptAndScenes), so the only schema change the
-- whole feature needs is teaching this constraint one more name.
--
-- 'kokoro_browser' — Kokoro-82M running in the user's browser via WebGPU.
-- The suffix matters: it records WHERE the audio was synthesized, so a future
-- server-side TTS would be a distinct provider value, not an ambiguity.

alter table public.transcripts
  drop constraint if exists transcripts_provider_check;

alter table public.transcripts
  add constraint transcripts_provider_check
  check (provider in ('assemblyai', 'groq_whisper', 'deepgram', 'openai_whisper', 'kokoro_browser'));
