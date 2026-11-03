import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave
from unittest.mock import Mock, patch


ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("funasr_service", ROOT / "python" / "funasr_service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def exchange(request, token=None):
    class Connection:
        def __init__(self):
            self.request = io.BytesIO(request)
            self.response = bytearray()

        def makefile(self, *_args):
            return self.request

        def sendall(self, data):
            self.response.extend(data)

    connection = Connection()
    with patch.object(service.Handler, "token", token):
        service.Handler(connection, ("127.0.0.1", 1), object())
    head, _, body = bytes(connection.response).partition(b"\r\n\r\n")
    return int(head.split()[1]), json.loads(body or b"{}")


class TranscriptTests(unittest.TestCase):
    def sentence(self, **kwargs):
        return {"text": "你好。", "start": 1000, "end": 2000,
                "timestamp": [[1000, 1500], [1500, 2000]], "spk": 0, **kwargs}

    def convert(self, *sentences):
        return service.transcript_from_results([{"text": "你好。", "sentence_info": list(sentences)}], 5, "zh")

    def test_sentence_words_and_speaker_share_real_timestamps(self):
        result = self.convert(self.sentence())
        self.assertTrue(result["hasWordTimestamps"])
        chunk = result["chunks"][0]
        self.assertEqual(chunk["timestamp"], [1, 2])
        self.assertEqual(chunk["speaker"], "SPEAKER_0")
        self.assertEqual([w["text"] for w in result["wordChunks"]], ["你", "好。"])
        self.assertEqual(chunk["wordIds"], [w["id"] for w in result["wordChunks"]])

    def test_word_text_preserves_spaces_and_punctuation(self):
        result = self.convert(self.sentence(text="Hello, world!"))
        self.assertEqual("".join(w["text"] for w in result["wordChunks"]), "Hello, world!")

    def test_partial_or_invalid_alignment_does_not_enable_word_editing(self):
        for stamps in [[], [[1000, 2000]], [[float("nan"), 1500], [1500, 2000]], [[1500, 1900], [1000, 1400]]]:
            result = self.convert(self.sentence(), self.sentence(start=3000, end=4000, timestamp=stamps))
            self.assertFalse(result["hasWordTimestamps"])
            self.assertEqual(result["wordChunks"], [])
            self.assertTrue(all("wordIds" not in c for c in result["chunks"]))

    def test_segment_results_keep_their_own_bounds(self):
        result = service.transcript_from_results(
            [{"text": "<|zh|><|HAPPY|>你好", "start": 1200, "end": 2400}, {"text": " ", "start": 3000, "end": 3500}], 5, "auto")
        self.assertEqual(result["text"], "你好")
        self.assertEqual(result["chunks"][0]["timestamp"], [1.2, 2.4])
        self.assertFalse(result["hasWordTimestamps"])


class SenseVoiceSentenceTests(unittest.TestCase):
    def test_sentences_follow_punctuation_and_real_token_times(self):
        # SenseVoice emits timed punctuation tokens as well.
        words = ["你", "好", "，", "世", "界", "。", "再", "见", "！"]
        stamps = [[0, 100], [100, 200], [200, 210], [300, 400], [400, 500], [500, 510], [700, 800], [800, 900], [900, 910]]
        sentences = service.split_sentences("<|zh|>你好，世界。再见！", words, stamps, 1000)
        self.assertEqual([s["text"] for s in sentences], ["你好，世界。", "再见！"])
        self.assertEqual((sentences[0]["start"], sentences[0]["end"]), (1000, 1500))
        self.assertEqual(sentences[1]["timestamp"], [[1700, 1800], [1800, 1900]])
        result = service.transcript_from_results(sentences, 5, "zh")
        self.assertTrue(result["hasWordTimestamps"])
        self.assertEqual(result["chunks"][1]["timestamp"], [1.7, 1.9])

    def test_long_comma_runs_are_split_and_unmatched_tokens_are_not_guessed(self):
        words = ["一", "二", "三", "四"]
        stamps = [[0, 3000], [3000, 6500], [6500, 7000], [7000, 7500]]
        sentences = service.split_sentences("一二，三四", words, stamps, 0)
        self.assertEqual([s["text"] for s in sentences], ["一二，", "三四"])
        # ITN turned the spoken token into a digit: the token is skipped, so word pairing fails safely.
        sentences = service.split_sentences("第1个", ["第", "一", "个"], [[0, 100], [100, 200], [200, 300]], 0)
        self.assertEqual(sentences[0]["text"], "第1个")
        self.assertFalse(service.transcript_from_results(sentences, 1, "zh")["hasWordTimestamps"])
        self.assertIsNone(service.split_sentences("", [], [], 0))


class ParaformerSentenceTests(unittest.TestCase):
    # Shaped like real FunASR 1.4 output: the top-level timestamps line up with the text, while
    # sentence_info moved a character (and its timestamp) into the wrong sentence.
    RESULT = {"text": "做IP好，我们说。", "timestamp": [[0, 100], [100, 300], [300, 400], [600, 700], [700, 800], [800, 900]],
              "sentence_info": [{"text": "做IP好，我", "start": 0, "end": 700, "timestamp": [[0, 100], [100, 300], [300, 400], [600, 700]], "spk": 0},
                                {"text": "们说。", "start": 700, "end": 900, "timestamp": [[700, 800], [800, 900]], "spk": 1}]}

    def test_sentences_are_rebuilt_from_top_level_timestamps(self):
        result = dict(self.RESULT, sentence_info=[dict(s, spk=None) for s in self.RESULT["sentence_info"]])
        transcript = service.transcript_from_results(service.paraformer_sentences(result), 1, "zh")
        self.assertTrue(transcript["hasWordTimestamps"])
        self.assertEqual([c["text"] for c in transcript["chunks"]], ["做IP好，", "我们说。"])
        self.assertEqual([w["text"] for w in transcript["wordChunks"]], ["做", "IP", "好，", "我", "们", "说。"])
        self.assertEqual(transcript["wordChunks"][1]["timestamp"], [0.1, 0.3])
        self.assertTrue(all("speaker" not in c for c in transcript["chunks"]))

    def test_sentences_split_where_the_speaker_changes(self):
        transcript = service.transcript_from_results(service.paraformer_sentences(self.RESULT), 1, "zh")
        self.assertEqual([(c["text"], c["speaker"]) for c in transcript["chunks"]],
                         [("做IP好，", "SPEAKER_0"), ("我", "SPEAKER_0"), ("们说。", "SPEAKER_1")])
        self.assertEqual([w["speaker"] for w in transcript["wordChunks"]], ["SPEAKER_0"] * 4 + ["SPEAKER_1"] * 2)

    def test_count_mismatch_keeps_funasr_sentences(self):
        self.assertIsNone(service.paraformer_sentences(dict(self.RESULT, timestamp=self.RESULT["timestamp"][:-1])))
        self.assertIsNone(service.paraformer_sentences({"text": "你好"}))


class OptionTests(unittest.TestCase):
    def test_declared_options_only(self):
        for options in [{"unknown": 1}, {"vad": "silero"}, {"hotword": 3}, {"batch_size_s": 0}, {"batch_size_s": True}]:
            with self.assertRaises(ValueError):
                service.check_options("paraformer-zh", options)
        with self.assertRaises(ValueError):
            service.check_options("sensevoice-small", {"hotword": "x"})

    def test_speaker_needs_vad_and_punctuation(self):
        with self.assertRaisesRegex(ValueError, "说话人"):
            service.check_options("paraformer-zh", {"speaker": "cam++", "punc": "none"})
        resolved = service.check_options("paraformer-zh", {"speaker": "cam++"})
        self.assertEqual((resolved["vad"], resolved["punc"], resolved["speaker"]), ("fsmn-vad", "ct-punc", "cam++"))


class ProtocolTests(unittest.TestCase):
    def test_health_and_models_follow_protocol(self):
        status, health = exchange(b"GET /v1/health HTTP/1.0\r\n\r\n")
        self.assertEqual((status, health["protocol"], health["version"]), (200, "flycut-provider", 1))
        status, models = exchange(b"GET /v1/models HTTP/1.0\r\n\r\n")
        rows = {m["id"]: m for m in models["models"]}
        self.assertEqual(rows["paraformer-zh"]["role"], "asr")
        self.assertEqual(rows["cam++"]["role"], "speaker")
        self.assertIn(rows["paraformer-zh"]["status"], ("ready", "download", "unavailable"))

    def test_missing_dependency_makes_models_unavailable_with_reason(self):
        with patch.object(service, "missing_dependency", return_value="缺少 funasr"):
            rows = service.model_rows()
        self.assertTrue(all(r["status"] == "unavailable" and r["reason"] == "缺少 funasr" for r in rows))

    def test_token_is_required_when_configured(self):
        self.assertEqual(exchange(b"GET /v1/models HTTP/1.0\r\n\r\n", token="secret")[0], 401)
        self.assertEqual(exchange(b"GET /v1/models HTTP/1.0\r\nAuthorization: Bearer secret\r\n\r\n", token="secret")[0], 200)

    def test_asr_job_validates_model_and_options_before_queueing(self):
        with patch.object(service.INFERENCE, "submit") as submit, patch.object(service, "missing_dependency", return_value=None):
            status, body = exchange(b"POST /v1/asr/jobs HTTP/1.0\r\nX-Flycut-Model: nope\r\nContent-Length: 3\r\n\r\nwav")
            self.assertEqual(status, 400)
            status, body = exchange(b"POST /v1/asr/jobs HTTP/1.0\r\nX-Flycut-Model: paraformer-zh\r\nX-Flycut-Options: {\"x\":1}\r\nContent-Length: 3\r\n\r\nwav")
            self.assertEqual(status, 400)
            options = json.dumps({"hotword": "飞剪"}).encode()  # ASCII-escaped, as the Host sends it
            status, body = exchange(b"POST /v1/asr/jobs HTTP/1.0\r\nX-Flycut-Model: paraformer-zh\r\nX-Flycut-Options: " + options + b"\r\nContent-Length: 3\r\n\r\nwav")
            self.assertEqual(status, 202)
            submit.assert_called_once()
            job_id = body["id"]
        status, job = exchange(f"GET /v1/jobs/{job_id} HTTP/1.0\r\n\r\n".encode())
        self.assertEqual((status, job["status"]), (200, "queued"))
        status, job = exchange(f"POST /v1/jobs/{job_id}/cancel HTTP/1.0\r\n\r\n".encode())
        self.assertEqual(job["status"], "cancelled")


class InferenceTests(unittest.TestCase):
    def test_paraformer_combination_is_loaded_once_and_requires_speakers(self):
        fake = Mock()
        fake.AutoModel.return_value.generate.return_value = [
            {"text": "你好。", "sentence_info": [{"text": "你好。", "start": 0, "end": 1000, "timestamp": [[0, 500], [500, 1000]], "spk": 1}]}]
        with tempfile.TemporaryDirectory() as home, patch.dict(sys.modules, {"funasr": fake}), \
                patch.object(service, "HOME", Path(home)), patch.object(service, "device", return_value="cpu"), \
                patch.object(service, "LOADED", {"key": None, "models": None}):
            for name in ("paraformer-zh", "fsmn-vad", "ct-punc", "cam++"):
                service.model_dir(name).mkdir(parents=True)
                (service.model_dir(name) / ".flycut-ready").touch()
            wav = Path(home) / "a.wav"
            with wave.open(str(wav), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(bytes(16000 * 2 * 2))
            run = lambda: service.transcribe("paraformer-zh", "zh", {"speaker": "cam++", "hotword": "飞剪"}, str(wav), lambda *_: None, lambda: False)
            result = run()
            run()
            self.assertEqual(fake.AutoModel.call_count, 1)
            kwargs = fake.AutoModel.call_args.kwargs
            self.assertEqual(kwargs["spk_model"], str(service.model_dir("cam++")))
            self.assertFalse(kwargs["trust_remote_code"])
            self.assertEqual(fake.AutoModel.return_value.generate.call_args.kwargs["hotword"], "飞剪")
            self.assertEqual(result["chunks"][0]["speaker"], "SPEAKER_1")
            fake.AutoModel.return_value.generate.return_value = [{"text": "你好。"}]
            with self.assertRaisesRegex(ValueError, "说话人"):
                run()


if __name__ == "__main__":
    unittest.main()
