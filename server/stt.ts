// Local speech-to-text for the push-to-talk flow, mirroring pi-voicekit:
// the same sherpa-onnx-native transducer recognizer and the same Parakeet v3
// model that pi-voicekit downloaded (~/.pi/models/parakeet-v3), with the
// native module resolved from pi's shared npm tree.
//
// This keeps sideshow's transcription byte-for-byte the same engine + weights
// pi-voicekit uses when the user holds ctrl+shift+v in the terminal.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_NPM_MODULES =
  process.env.PI_AGENT_NPM_MODULES ??
  join(homedir(), ".pi", "agent", "npm", "node_modules");
const MODEL_DIR =
  process.env.SIDESHOW_STT_MODEL_DIR ?? join(homedir(), ".pi", "models", "parakeet-v3");

const MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

export function sttAvailable(): boolean {
  try {
    return MODEL_FILES.every((f) => existsSync(join(MODEL_DIR, f)));
  } catch {
    return false;
  }
}

let cachedRecognizer: any = null;

/** True once the recognizer (and its ~1.7 GB of weights) is loaded. */
export function modelLoaded(): boolean {
  return cachedRecognizer != null;
}

function loadSherpa(): any {
  const require = createRequire(join(PI_NPM_MODULES, "pi-voicekit", "package.json"));
  const ns: any = require("sherpa-onnx-node");
  // CJS interop: the populated namespace may sit on `.default` (see
  // pi-voicekit's sherpa-loader.ts for the full matrix).
  if (typeof ns?.OfflineRecognizer === "function") return ns;
  if (typeof ns?.default?.OfflineRecognizer === "function") return ns.default;
  throw new Error("sherpa-onnx-node loaded but OfflineRecognizer not found");
}

export async function getRecognizer(): Promise<any> {
  if (cachedRecognizer) return cachedRecognizer;
  const sherpa = loadSherpa();
  // Same config pi-voicekit's createTransducerRecognizer builds for parakeet-v3.
  cachedRecognizer = new sherpa.OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: join(MODEL_DIR, "decoder.int8.onnx"),
        joiner: join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: join(MODEL_DIR, "tokens.txt"),
      numThreads: 4,
      provider: "cpu",
    },
  });
  return cachedRecognizer;
}

// 16-bit signed LE PCM → Float32Array in [-1, 1] (same routine pi-voicekit runs).
function pcmToFloat32(pcm: Buffer): Float32Array {
  const numSamples = Math.floor(pcm.length / 2);
  const float32 = new Float32Array(numSamples);
  if ((pcm.byteOffset & 1) !== 0) {
    for (let i = 0; i < numSamples; i++) {
      float32[i] = pcm.readInt16LE(i * 2) / 32768.0;
    }
    return float32;
  }
  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

/** Transcribe a 16 kHz mono s16le PCM buffer. Resolves to "" on silence. */
export async function transcribePcm(pcm: Buffer): Promise<string> {
  const recognizer = await getRecognizer();
  const samples = pcmToFloat32(pcm);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  await recognizer.decodeAsync(stream);
  return ((recognizer.getResult(stream) as any)?.text ?? "").trim();
}
