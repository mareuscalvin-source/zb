# Pack a Piper voice model into files a claude.ai page can host.
#
# The page can only serve web file types, so the weights travel as text: float16, byte-shuffled,
# gzipped, then base64 in parts under 15 MB. The browser undoes each step and hands
# onnxruntime-web the float32 weights as external data for the slimmed graph.
#
# Source model (CC BY 4.0, 904 LibriTTS-R speakers), from the sherpa-onnx mirror of Piper's voices:
#   https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts_r-medium.tar.bz2
# Usage: python dev/voice-pack.py <path/to/en_US-libritts_r-medium.onnx> <out dir>
import base64, hashlib, json, os, sys, tempfile, zlib

import numpy as np
import onnx
from onnx import external_data_helper, numpy_helper

src, out = sys.argv[1], sys.argv[2]
cfg = json.load(open(src + '.json'))
model = onnx.load(src)

# Move every float32 tensor of 1k+ values out of the graph, into one external file.
with tempfile.TemporaryDirectory() as tmp:
    external_data_helper.convert_model_to_external_data(model, all_tensors_to_one_file=True, location='zb.data', size_threshold=4096)
    onnx.save_model(model, os.path.join(tmp, 'graph.onnx'))
    graph = open(os.path.join(tmp, 'graph.onnx'), 'rb').read()
    data = open(os.path.join(tmp, 'zb.data'), 'rb').read()

tensors = []
halves = []
for t in model.graph.initializer:
    if t.data_location != onnx.TensorProto.EXTERNAL:
        continue
    info = {e.key: e.value for e in t.external_data}
    off, length = int(info['offset']), int(info['length'])
    assert t.data_type == onnx.TensorProto.FLOAT, t.name
    a = np.frombuffer(data[off:off + length], dtype=np.float32)
    tensors.append([off, a.size])
    halves.append(a.astype(np.float16))

h = np.concatenate(halves).view(np.uint8).reshape(-1, 2)
shuffled = np.concatenate([h[:, 1], h[:, 0]]).tobytes()  # high bytes, then low bytes: gzip packs these better
co = zlib.compressobj(9, zlib.DEFLATED, -15)  # raw deflate wrapped as gzip, for the browser's DecompressionStream
deflated = co.compress(shuffled) + co.flush()
gz = b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff' + deflated + zlib.crc32(shuffled).to_bytes(4, 'little') + (len(shuffled) & 0xffffffff).to_bytes(4, 'little')
b64 = base64.b64encode(gz).decode()

os.makedirs(out, exist_ok=True)
PART = 14_000_000
parts = []
for i in range(0, len(b64), PART):
    name = f'zb-voice-{len(parts) + 1}.txt'
    open(os.path.join(out, name), 'w').write(b64[i:i + PART])
    parts.append(name)

manifest = {
    'version': hashlib.sha256(gz).hexdigest()[:16],
    'sampleRate': cfg['audio']['sample_rate'],
    'speakers': cfg.get('num_speakers', 1),
    'inference': cfg['inference'],
    'phonemeIds': cfg['phoneme_id_map'],
    'graph': base64.b64encode(graph).decode(),
    'dataBytes': len(data),
    'halfBytes': len(shuffled),
    'gzipBytes': len(gz),
    'tensors': tensors,
    'parts': parts,
    'license': 'Piper voice en_US-libritts_r-medium, trained on LibriTTS-R (CC BY 4.0)',
}
json.dump(manifest, open(os.path.join(out, 'zb-voice.json'), 'w'), separators=(',', ':'))
print(f'graph {len(graph) / 1e6:.2f} MB, weights {len(data) / 1e6:.1f} MB fp32 -> {len(gz) / 1e6:.1f} MB gzip -> {len(b64) / 1e6:.1f} MB text in {len(parts)} parts')
