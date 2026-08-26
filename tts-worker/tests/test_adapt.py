"""The Adapt wrapper against a REAL onnxruntime session, not a mock.

The wrapper exists for two located defects in how kokoro-onnx 0.4.9 feeds
the onnx-community export; a mock would only pin our idea of ORT's behavior.
The tiny model here reproduces both defect surfaces exactly: an input
declared tensor(float) named `speed` (which kokoro-onnx feeds as int32), and
an output shaped (1, N) (which kokoro-onnx assumes is flat).
"""

import os
import sys

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import TensorProto, helper

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.adapt import TYPEMAP, Adapt  # noqa: E402


@pytest.fixture(scope="module")
def session(tmp_path_factory):
    # out = (input_ids summed as float) * speed, shaped (1, 4) — 2-D on
    # purpose, like the real export's audio output.
    ids_in = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, 4])
    speed_in = helper.make_tensor_value_info("speed", TensorProto.FLOAT, [1])
    out = helper.make_tensor_value_info("audio", TensorProto.FLOAT, [1, 4])
    cast = helper.make_node("Cast", ["input_ids"], ["ids_f"], to=TensorProto.FLOAT)
    mul = helper.make_node("Mul", ["ids_f", "speed"], ["audio"])
    graph = helper.make_graph([cast, mul], "adapt-probe", [ids_in, speed_in], [out])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    path = str(tmp_path_factory.mktemp("m") / "probe.onnx")
    onnx.save(model, path)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])


class TestAdaptIn:
    def test_bare_session_rejects_int32_speed(self, session):
        # The defect being fixed: kokoro-onnx sends speed as int32 on the
        # input_ids export. A bare session refuses it.
        with pytest.raises(Exception):
            session.run(
                None,
                {"input_ids": [[0, 1, 2, 3]], "speed": np.array([1], dtype=np.int32)},
            )

    def test_adapt_coerces_each_input_to_its_declared_type(self, session):
        wrapped = Adapt(FakePathSession(session))
        out = wrapped.run(
            None,
            {"input_ids": [[0, 1, 2, 3]], "speed": np.array([2], dtype=np.int32)},
        )
        assert out[0].tolist() == [0.0, 2.0, 4.0, 6.0]


class TestAdaptOut:
    def test_2d_output_is_flattened(self, session):
        # The defect being fixed: kokoro-onnx computes duration as
        # len(audio) / 24000 and joins with np.concatenate — a (1, N) array
        # gives len 1 and concatenates rows.
        bare = session.run(
            None, {"input_ids": [[0, 1, 2, 3]], "speed": np.array([1.0], dtype=np.float32)}
        )
        assert bare[0].ndim == 2 and len(bare[0]) == 1  # the broken shape

        wrapped = Adapt(FakePathSession(session))
        out = wrapped.run(
            None, {"input_ids": [[0, 1, 2, 3]], "speed": np.array([1], dtype=np.int32)}
        )
        assert out[0].ndim == 1
        assert len(out[0]) == 4  # duration arithmetic is now right


class TestFromSessionSurface:
    def test_exposes_exactly_what_kokoro_from_session_reads(self, session):
        wrapped = Adapt(FakePathSession(session))
        assert wrapped._model_path == "/fake/model.onnx"
        assert [i.name for i in wrapped.get_inputs()] == ["input_ids", "speed"]

    def test_typemap_covers_the_declared_types_of_the_real_export(self):
        # The verified export declares: input_ids int64, style float, speed float.
        assert TYPEMAP["tensor(int64)"] is np.int64
        assert TYPEMAP["tensor(float)"] is np.float32


class FakePathSession:
    """The real export's session carries _model_path; InferenceSession here
    does too, but under a name that varies by ORT version — pin our own."""

    def __init__(self, session):
        self._s = session
        self._model_path = "/fake/model.onnx"

    def get_inputs(self):
        return self._s.get_inputs()

    def run(self, names, feed, ro=None):
        return self._s.run(names, feed, ro)
