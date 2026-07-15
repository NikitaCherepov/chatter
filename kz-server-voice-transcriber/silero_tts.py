import torch
import sys
import soundfile as sf

SAMPLE_RATE = 48000
MODEL_ID = 'v4_ru'
SPEAKER = 'eugene'


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: silero_tts.py <text> <output_path>')

    text = sys.argv[1].strip()
    output_path = sys.argv[2]
    if not text:
        raise SystemExit('Text must not be empty')

    torch.set_num_threads(2)
    model, _ = torch.hub.load(
        repo_or_dir='snakers4/silero-models',
        model='silero_tts',
        language='ru',
        speaker=MODEL_ID,
        trust_repo=True,
        force_reload=False
    )
    model.to(torch.device('cpu'))

    audio = model.apply_tts(text=text, speaker=SPEAKER, sample_rate=SAMPLE_RATE)
    sf.write(output_path, audio.numpy(), SAMPLE_RATE)


if __name__ == '__main__':
    main()
