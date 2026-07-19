import json
import os
import sys
import wave
from pathlib import Path

from piper import PiperVoice


def require_env(name: str) -> str:
    value = os.getenv(name, '').strip()
    if not value:
        raise RuntimeError(f'{name} is required')
    return value


def send(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> None:
    model_path = Path(require_env('PIPER_MODEL_PATH')).expanduser().resolve()
    config_value = os.getenv('PIPER_CONFIG_PATH', '').strip()
    config_path = Path(config_value).expanduser().resolve() if config_value else None

    if not model_path.is_file():
        raise FileNotFoundError(f'Piper model not found: {model_path}')
    if config_path is not None and not config_path.is_file():
        raise FileNotFoundError(f'Piper config not found: {config_path}')

    voice = PiperVoice.load(
        model_path,
        config_path=config_path,
        use_cuda=False,
    )
    send({'event': 'ready'})

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        request_id = None
        output_path = None
        try:
            request = json.loads(raw_line)
            request_id = request.get('id')
            text = str(request.get('text') or '').strip()
            output_path = Path(str(request.get('output_path') or '')).resolve()
            if not request_id or not text or not str(request.get('output_path') or '').strip():
                raise ValueError('id, text and output_path are required')

            output_path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(output_path), 'wb') as wav_file:
                voice.synthesize_wav(text, wav_file)

            if not output_path.is_file() or output_path.stat().st_size <= 44:
                raise RuntimeError('Piper produced an empty WAV file')
            send({'id': request_id, 'ok': True})
        except Exception as error:
            if output_path is not None:
                try:
                    output_path.unlink(missing_ok=True)
                except OSError:
                    pass
            send({'id': request_id, 'ok': False, 'error': str(error)})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'[piper-worker] {error}', file=sys.stderr, flush=True)
        raise SystemExit(1)
