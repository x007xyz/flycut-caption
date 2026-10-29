import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "python" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load("funasr_runner", "funasr_runner.py")
runtime = load("flycut_runtime", "flycut_runtime.py")


class FunASRTests(unittest.TestCase):
    def sentence(self, **kwargs):
        return {"text": "你好。", "start": 1000, "end": 2000,
                "timestamp": [[1000, 1500], [1500, 2000]], "spk": 0, **kwargs}

    def convert(self, *sentences):
        return runner.transcript_from_results(
            [{"text": "你好。", "sentence_info": list(sentences)}], 5, "zh")

    def test_sentence_words_and_speaker_share_real_timestamps(self):
        result = self.convert(self.sentence())
        self.assertTrue(result["hasWordTimestamps"])
        chunk = result["chunks"][0]
        self.assertEqual(chunk["timestamp"], [1, 2])
        self.assertEqual(chunk["speaker"], "SPEAKER_0")
        self.assertEqual([w["text"] for w in result["wordChunks"]], ["你", "好。"])
        self.assertEqual(result["wordChunks"][0]["timestamp"], [1, 1.5])
        self.assertTrue(all(w["speaker"] == "SPEAKER_0" and w["sentenceId"] == chunk["id"] for w in result["wordChunks"]))
        self.assertEqual(chunk["wordIds"], [w["id"] for w in result["wordChunks"]])

    def test_different_speakers_are_preserved(self):
        result = self.convert(self.sentence(), self.sentence(start=3000, end=4000, spk=1, timestamp=[[3000, 3500], [3500, 4000]]))
        self.assertEqual([c["speaker"] for c in result["chunks"]], ["SPEAKER_0", "SPEAKER_1"])

    def test_word_text_preserves_spaces_and_punctuation(self):
        result = self.convert(self.sentence(text="Hello, world!"))
        self.assertTrue(result["hasWordTimestamps"])
        self.assertEqual("".join(w["text"] for w in result["wordChunks"]), "Hello, world!")

    def test_partial_or_invalid_alignment_does_not_enable_word_editing(self):
        for stamps in [[], [[1000, 2000]], [[float("nan"), 1500], [1500, 2000]], [[1500, 1900], [1000, 1400]], [[1000, 500], [1500, 2000]]]:
            result = self.convert(self.sentence(), self.sentence(timestamp=stamps))
            self.assertFalse(result["hasWordTimestamps"])
            self.assertEqual(result["wordChunks"], [])
            self.assertTrue(all("wordIds" not in c for c in result["chunks"]))

    def test_sensevoice_tags_and_missing_timestamps(self):
        result = runner.transcript_from_results([{"text": "<|zh|><|HAPPY|>你好"}], 5, "auto")
        self.assertEqual(result["text"], "你好")
        self.assertEqual(result["chunks"][0]["timestamp"], [0, 5])
        self.assertFalse(result["hasWordTimestamps"])
        self.assertNotIn("speaker", result["chunks"][0])

    def test_silence(self):
        self.assertEqual(runner.transcript_from_results([{"text": " "}], 5, "zh")["chunks"], [])

    def test_local_models_and_config_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            for config in [{"spk_model": directory}, {"trust_remote_code": True}, {"vad_model": "fsmn-vad"}, {"device": "arbitrary"}]:
                with self.assertRaises(ValueError):
                    runner.model_options(directory, config)
            options = runner.model_options(directory, {"vad_model": directory, "punc_model": directory, "spk_model": directory})
            self.assertEqual(options["model"], str(Path(directory).resolve()))
            self.assertFalse(options["trust_remote_code"])

    def test_check_protocol_keeps_library_logs_off_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "funasr.py").write_text("print('library log')\nclass AutoModel: pass\n")
            process = subprocess.run([sys.executable, str(ROOT / "python/funasr_runner.py"), "--check"],
                                     env={**os.environ, "PYTHONPATH": directory}, capture_output=True, text=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(process.stdout), {"ready": True})
            self.assertIn("library log", process.stderr)

    def test_runtime_dispatches_funasr_and_preserves_config(self):
        config = {"device": "cpu", "vad_model": "/local/vad", "spk_model": "/local/cam"}
        model = {"id": "custom-funasr", "provider": "funasr", "path": "/local/asr", "config": config}
        with patch.object(runtime.subprocess, "run") as process:
            process.return_value = type("Result", (), {"returncode": 0, "stdout": '{"chunks": []}'})()
            self.assertEqual(runtime.run_model(model, "zh", b"wav"), {"chunks": []})
            command = process.call_args[0][0]
            self.assertTrue(command[1].endswith("funasr_runner.py"))
            self.assertEqual(json.loads(command[command.index("--config") + 1]), config)
        with self.assertRaises(ValueError):
            runtime.run_model({**model, "provider": "unknown"}, "zh", b"wav")

    def test_runner_wires_automodel_and_requires_requested_speakers(self):
        from unittest.mock import Mock
        fake = Mock()
        fake.AutoModel.return_value.generate.return_value = [
            {"text": "你好。", "sentence_info": [self.sentence()]}]

        def transcode(command, **_kwargs):
            with wave.open(command[-1], "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(bytes(16000 * 2 * 5))

        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {"funasr": fake}), patch.object(runner.subprocess, "run", side_effect=transcode):
            config = {"vad_model": directory, "punc_model": directory, "spk_model": directory}
            args = SimpleNamespace(check=False, model=directory, input="media.mp4", language="zh", config=json.dumps(config))
            output = runner.run(args)
            self.assertEqual(output["duration"], 5)
            self.assertEqual(output["chunks"][0]["speaker"], "SPEAKER_0")
            self.assertEqual(fake.AutoModel.call_args.kwargs["spk_model"], str(Path(directory).resolve()))
            self.assertEqual(fake.AutoModel.return_value.generate.call_args.kwargs["language"], "zh")
            fake.AutoModel.return_value.generate.return_value = [{"text": "你好。"}]
            with self.assertRaisesRegex(ValueError, "未返回说话人"):
                runner.run(args)

    def test_discovery_does_not_offer_auxiliary_checkpoints_as_asr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, model_class in [("asr", "Paraformer"), ("vad", "FsmnVADStreaming"), ("speaker", "CAMPPlus")]:
                model = root / name
                model.mkdir()
                (model / "config.yaml").write_text(f"model: {model_class}\n")
                (model / "model.pt").touch()
            with patch.object(runtime, "model_roots", return_value=[root]):
                candidates = runtime.discover_models()
            self.assertEqual([(c["name"], c["provider"]) for c in candidates], [("asr", "funasr")])

    def test_async_http_job_accepts_funasr_and_cors_headers(self):
        class Connection:
            def __init__(self, request):
                self.request = io.BytesIO(request)
                self.response = bytearray()

            def makefile(self, *_args):
                return self.request

            def sendall(self, data):
                self.response.extend(data)

        def exchange(request):
            connection = Connection(request)
            runtime.Handler(connection, ("127.0.0.1", 1), object())
            return bytes(connection.response)

        model = {"id": "custom-funasr", "provider": "funasr"}
        with patch.object(runtime, "read_catalog", return_value=[model]), patch.object(runtime.EXECUTOR, "submit") as submit:
            response = exchange(b"POST /v1/asr/jobs HTTP/1.0\r\nContent-Length: 3\r\nX-Flycut-Model: custom-funasr\r\n\r\nwav")
            self.assertIn(b"202 Accepted", response)
            self.assertEqual(json.loads(response.split(b"\r\n\r\n")[1])["status"], "queued")
            submit.assert_called_once()
            response = exchange(b"OPTIONS /v1/asr/jobs HTTP/1.0\r\n\r\n")
            self.assertIn(b"Access-Control-Allow-Headers: Content-Type, X-Flycut-Model", response)
            response = exchange(b"GET /health HTTP/1.0\r\n\r\n")
            self.assertIn("funasr", json.loads(response.split(b"\r\n\r\n")[1])["providers"])



if __name__ == "__main__":
    unittest.main()
