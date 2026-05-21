import argparse
import json
import sys
import time

import numpy as np
import sounddevice as sd
from openwakeword.model import Model


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--debounce", type=float, default=2.0)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--block-ms", type=int, default=80)
    parser.add_argument("--vad-threshold", type=float, default=0.45)
    args = parser.parse_args()

    block_size = int(args.sample_rate * args.block_ms / 1000)

    eprint("[wakeword] loading model...")

    # Without wakeword_models — loads default built-in openWakeWord models.
    # Good enough for the first test before training a custom phrase.
    model = Model(vad_threshold=args.vad_threshold, inference_framework="onnx")

    eprint("[wakeword] model loaded")
    eprint(f"[wakeword] sample_rate={args.sample_rate}, block_size={block_size}")

    last_detection = 0.0

    with sd.InputStream(
        samplerate=args.sample_rate,
        channels=1,
        dtype="int16",
        blocksize=block_size,
    ) as stream:
        eprint("[wakeword] listening...")

        while True:
            audio, overflowed = stream.read(block_size)

            if overflowed:
                eprint("[wakeword] audio overflow")

            frame = np.squeeze(audio)

            predictions = model.predict(frame)

            if not predictions:
                continue

            name, score = max(predictions.items(), key=lambda item: item[1])
            now = time.time()

            if score >= args.threshold and now - last_detection >= args.debounce:
                last_detection = now

                print(
                    json.dumps({
                        "type": "wakeword",
                        "name": name,
                        "score": float(score),
                        "ts": now,
                    }, ensure_ascii=False),
                    flush=True,
                )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as err:
        print(
            json.dumps({
                "type": "error",
                "message": str(err),
            }, ensure_ascii=False),
            flush=True,
        )
        raise
