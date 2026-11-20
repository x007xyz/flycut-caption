#!/usr/bin/env python3
"""Local sherpa-onnx speaker diarization used by the Host when a speaker model is configured."""
import argparse, json, os, wave
import numpy as np
import sherpa_onnx

parser = argparse.ArgumentParser()
parser.add_argument('--wav', required=True)
parser.add_argument('--model-dir', required=True)
parser.add_argument('--threshold', type=float, default=0.5)
args = parser.parse_args()
with wave.open(args.wav, 'rb') as handle:
    if handle.getframerate() != 16000 or handle.getnchannels() != 1:
        raise SystemExit('expected 16 kHz mono WAV')
    samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32) / 32768
config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
            model=os.path.join(args.model_dir, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'))),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=os.path.join(args.model_dir, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx')),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=args.threshold),
    min_duration_on=0.3, min_duration_off=0.5)
if not config.validate():
    raise SystemExit('invalid diarization config')
result = sherpa_onnx.OfflineSpeakerDiarization(config).process(samples.tolist()).sort_by_start_time()
print(json.dumps({'duration': len(samples) / 16000,
  'segments': [{'speaker': str(segment.speaker), 'start': segment.start, 'end': segment.end} for segment in result]}))
