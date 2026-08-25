# Model files — placed here by the operator before `docker compose build`

The image bakes the model and voices in; nothing is downloaded at runtime.
Put these files in this directory (they are gitignored — the repo never
carries 325 MB of weights):

| File | Exact size (bytes) | What it is |
|---|---|---|
| `model.onnx` | 325,532,232 | The onnx-community Kokoro-82M export — the same file already in the R2 bucket and used by the browser path |
| `af_heart.bin` | 522,240 | Voice style vectors, `(510, 1, 256)` float32 |
| *(other voices)* `.bin` | 522,240 each | One per voice offered in the app (five today) |

The build **fails loudly** if `model.onnx` is not byte-exact or any `.bin`
has the wrong size — a truncated file must break the build, never ship.

Fastest way to fill this directory on the VPS: download from the R2 bucket
(the same objects the browser fetches), e.g.

```
BASE=https://pub-42a1fa5fb300434c9a06eaf5b7966394.r2.dev/onnx-community/Kokoro-82M-v1.0-ONNX/main
curl -fLo model.onnx  "$BASE/onnx/model.onnx"
for v in af_heart af_bella am_michael am_fenrir bf_emma; do
  curl -fLo "$v.bin" "$BASE/voices/$v.bin"
done
ls -l   # verify sizes against the table above
```

(The list above is `TTS_VOICES` from `src/lib/tts/generate.ts` as of Round B:
af_heart, af_bella, am_michael, am_fenrir, bf_emma. The worker validates the
submitted voice against what was actually baked, so a missing voice fails a
submission loudly rather than substituting a different narrator.)
