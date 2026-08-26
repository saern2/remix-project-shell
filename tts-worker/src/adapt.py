"""The two adaptations that make kokoro-onnx 0.4.9 run the onnx-community export.

Both defects were located at source (kokoro_onnx/__init__.py, verified against
the installed 0.4.9 wheel) and both fixes were tested on the operator's exact
model file (model.onnx, 325,532,232 bytes) before this round began:

  IN  — on the input_ids export, kokoro-onnx feeds `speed` as int32
        (`np.array([speed], dtype=np.int32)` in _create_audio) while this
        model declares tensor(float). Feed each input as DECLARED, from the
        session's own metadata, so a future export changing a dtype is
        handled by reading it rather than by another hardcode.
  OUT — this export returns shape (1, N); kokoro-onnx assumes flat (N,):
        it computes duration as len(audio) / SAMPLE_RATE (== 1/24000 s for a
        2-D array) and joins batches with np.concatenate along axis 0, which
        would concatenate rows instead of samples. Flatten before returning.

The wrapper exposes exactly the surface Kokoro.from_session touches:
`_model_path` (read by from_session), `get_inputs()` and `run()`.
"""

from __future__ import annotations

import numpy as np

TYPEMAP = {
    "tensor(float)": np.float32,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(double)": np.float64,
}


class Adapt:
    """Session wrapper: inputs coerced to their declared dtypes, output flattened."""

    def __init__(self, session):
        self._s = session
        self._model_path = session._model_path
        self._t = {i.name: TYPEMAP.get(i.type) for i in session.get_inputs()}

    def get_inputs(self):
        return self._s.get_inputs()

    def run(self, names, feed, ro=None):
        coerced = {
            k: (np.asarray(v, dtype=self._t[k]) if self._t.get(k) else v)
            for k, v in feed.items()
        }
        out = list(self._s.run(names, coerced, ro))
        if out and isinstance(out[0], np.ndarray) and out[0].ndim > 1:
            out[0] = np.asarray(out[0]).reshape(-1)
        return out
