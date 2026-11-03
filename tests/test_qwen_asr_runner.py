import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace as Obj
import unittest

spec = importlib.util.spec_from_file_location("qwen_runner", Path(__file__).parents[1] / "python/qwen_asr_runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class QwenOutputTests(unittest.TestCase):
    def result(self, text="hello", stamps=None):
        return Obj(text=text, language="English", time_stamps=stamps)

    def test_segment_output_does_not_invent_words(self):
        output = runner.transcript_from_results([self.result()], [(25, 30)], 30)
        self.assertFalse(output["hasWordTimestamps"])
        self.assertTrue(all("wordIds" not in chunk for chunk in output["chunks"]))
        self.assertEqual(output["wordChunks"], [])
        self.assertEqual(output["chunks"][0]["timestamp"], [25, 30])

    def test_aligner_timestamps_use_window_offset_and_sentence_links(self):
        word = Obj(text="hello", start_time=0.5, end_time=1)
        output = runner.transcript_from_results([self.result(stamps=[word])], [(25, 30)], 30)
        self.assertTrue(output["hasWordTimestamps"])
        self.assertEqual(output["wordChunks"][0]["timestamp"], [25.5, 26])
        self.assertEqual(output["wordChunks"][0]["sentenceId"], output["chunks"][0]["id"])
        self.assertEqual(output["chunks"][0]["wordIds"], [output["wordChunks"][0]["id"]])

    def test_invalid_alignment_does_not_enable_word_editing(self):
        for start, end in [(float("nan"), 1), (2, 1), (50, 51), (0, float("inf"))]:
            word = Obj(text="hello", start_time=start, end_time=end)
            output = runner.transcript_from_results([self.result(stamps=[word])], [(0, 10)], 10)
            self.assertFalse(output["hasWordTimestamps"])

    def test_partial_alignment_does_not_enable_word_editing(self):
        output = runner.transcript_from_results(
            [self.result(stamps=[Obj(text="hello", start_time=0, end_time=1)]), self.result()],
            [(0, 25), (25, 30)], 30)
        self.assertFalse(output["hasWordTimestamps"])
        self.assertTrue(all("wordIds" not in chunk for chunk in output["chunks"]))

    def test_check_protocol_keeps_dependency_logs_off_stdout(self):
        # No heavyweight dependencies are required to test the subprocess protocol.
        with tempfile.TemporaryDirectory() as temp:
            for name in ["torch", "numpy"]:
                Path(temp, name + ".py").write_text("print('dependency log')\n")
            Path(temp, "qwen_asr.py").write_text("print('qwen log')\nclass Qwen3ASRModel: pass\n")
            process = subprocess.run([sys.executable, str(spec.origin), "--check"],
                                     env={**os.environ, "PYTHONPATH": temp}, capture_output=True, text=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(process.stdout), {"ready": True})
            self.assertIn("dependency log", process.stderr)

    def test_missing_dependency_returns_actionable_error(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "torch.py").write_text("raise ImportError('missing torch')\n")
            process = subprocess.run([sys.executable, str(spec.origin), "--check"],
                                     env={**os.environ, "PYTHONPATH": temp}, capture_output=True, text=True)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(process.stdout, "")
            self.assertIn("qwen-asr", process.stderr)

    def test_silence_and_language_mapping(self):
        output = runner.transcript_from_results([self.result(text=" ")], [(0, 10)], 10)
        self.assertEqual(output["chunks"], [])
        self.assertFalse(output["hasWordTimestamps"])
        self.assertIsNone(runner.normalize_language("auto"))
        self.assertEqual(runner.normalize_language("zh"), "Chinese")
        self.assertEqual(runner.normalize_language("yue"), "Cantonese")


if __name__ == "__main__":
    unittest.main()
