#!/usr/bin/env python3
"""
voice-identify.py — Speaker identification using resemblyzer

Commands:
  enroll  "Name" <audio_file>           Enroll a person's voice
  identify <audio_file> <segments.json> Identify speakers in a recording
  list                                  Show enrolled profiles
  delete  "Name"                        Remove a profile

Uses resemblyzer (GE2E speaker encoder) to create voice embeddings.
Profiles stored in voice-profiles-embeddings.npz alongside voice-profiles.json.
"""

import sys
import os
import json
import subprocess
import tempfile
import numpy as np

PROFILES_PATH = os.path.join(os.path.dirname(__file__), 'voice-profiles.json')
EMBEDDINGS_PATH = os.path.join(os.path.dirname(__file__), 'voice-profiles-embeddings.npz')

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_profiles():
    try:
        with open(PROFILES_PATH) as f:
            return json.load(f)
    except:
        return {}

def save_profiles(profiles):
    with open(PROFILES_PATH, 'w') as f:
        json.dump(profiles, f, indent=2)

def load_embeddings():
    if not os.path.exists(EMBEDDINGS_PATH):
        return {}
    data = np.load(EMBEDDINGS_PATH, allow_pickle=True)
    return {k: data[k] for k in data.files}

def save_embeddings(embeddings):
    np.savez(EMBEDDINGS_PATH, **embeddings)

def get_encoder():
    from resemblyzer import VoiceEncoder
    return VoiceEncoder()

def audio_to_wav(input_path, output_path):
    """Convert any audio format to 16kHz mono WAV using ffmpeg."""
    subprocess.run([
        'ffmpeg', '-y', '-i', input_path,
        '-ar', '16000', '-ac', '1', '-f', 'wav', output_path,
        '-loglevel', 'error'
    ], check=True, timeout=60)

def extract_speaker_segments(audio_path, segments, speaker_id):
    """Extract all audio segments for a speaker and concatenate."""
    speaker_segs = [s for s in segments if s.get('speaker') == speaker_id]
    if not speaker_segs:
        return None

    with tempfile.TemporaryDirectory() as tmpdir:
        seg_files = []
        for i, seg in enumerate(speaker_segs):
            dur = seg['end'] - seg['start']
            if dur < 1.0:
                continue
            seg_path = os.path.join(tmpdir, f'seg_{i}.wav')
            try:
                subprocess.run([
                    'ffmpeg', '-y',
                    '-ss', str(seg['start']),
                    '-t', str(round(dur, 3)),
                    '-i', audio_path,
                    '-ar', '16000', '-ac', '1', seg_path,
                    '-loglevel', 'error'
                ], check=True, timeout=30)
                if os.path.exists(seg_path) and os.path.getsize(seg_path) > 1000:
                    seg_files.append(seg_path)
            except:
                continue

        if not seg_files:
            return None

        # Concatenate
        list_path = os.path.join(tmpdir, 'list.txt')
        out_path = os.path.join(tmpdir, 'combined.wav')
        with open(list_path, 'w') as f:
            f.write('\n'.join(f"file '{p}'" for p in seg_files))

        subprocess.run([
            'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
            '-i', list_path, '-ar', '16000', '-ac', '1', out_path,
            '-loglevel', 'error'
        ], check=True, timeout=60)

        if not os.path.exists(out_path):
            return None

        # Return as bytes so tempdir can be cleaned up
        with open(out_path, 'rb') as f:
            return f.read()

def embed_wav_bytes(encoder, wav_bytes):
    """Compute speaker embedding from WAV bytes."""
    import io
    import soundfile as sf
    from resemblyzer import preprocess_wav

    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype='float32')
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    wav = preprocess_wav(audio, source_sr=16000)
    return encoder.embed_utterance(wav)

def cosine_similarity(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))

# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_enroll(name, audio_path):
    if not os.path.exists(audio_path):
        print(f'ERROR: File not found: {audio_path}', file=sys.stderr)
        sys.exit(1)

    print(f'Loading voice encoder...', file=sys.stderr)
    encoder = get_encoder()

    print(f'Processing audio for "{name}"...', file=sys.stderr)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        audio_to_wav(audio_path, tmp_path)
        from resemblyzer import preprocess_wav
        import soundfile as sf
        audio, sr = sf.read(tmp_path, dtype='float32')
        # Cap at 90 seconds to stay within RAM limits on 2GB server
        max_samples = 90 * sr
        if len(audio) > max_samples:
            print(f'Audio is {len(audio)/sr:.0f}s — trimming to 90s for enrollment', file=sys.stderr)
            audio = audio[:max_samples]
        from resemblyzer import preprocess_wav
        wav = preprocess_wav(audio, source_sr=sr)
        embedding = encoder.embed_utterance(wav)
    finally:
        try: os.unlink(tmp_path)
        except: pass

    # Save embedding
    embeddings = load_embeddings()
    embeddings[name] = embedding
    save_embeddings(embeddings)

    # Update profiles JSON
    profiles = load_profiles()
    profiles[name] = profiles.get(name, {})
    profiles[name]['enrolled_at'] = __import__('datetime').datetime.utcnow().isoformat()
    profiles[name]['method'] = 'resemblyzer'
    save_profiles(profiles)

    print(json.dumps({
        'status': 'enrolled',
        'name': name,
        'embedding_dim': len(embedding)
    }))

def cmd_identify(audio_path, segments_path):
    embeddings = load_embeddings()
    if not embeddings:
        print(json.dumps({'error': 'No enrolled profiles'}))
        return

    with open(segments_path) as f:
        segments = json.load(f)

    unique_speakers = list(set(s.get('speaker') for s in segments if s.get('speaker')))
    if not unique_speakers:
        print(json.dumps({}))
        return

    print(f'Loading voice encoder...', file=sys.stderr)
    encoder = get_encoder()

    result = {}
    for speaker_id in unique_speakers:
        wav_bytes = extract_speaker_segments(audio_path, segments, speaker_id)
        if not wav_bytes or len(wav_bytes) < 8000:
            print(f'{speaker_id}: not enough audio', file=sys.stderr)
            continue

        try:
            embedding = embed_wav_bytes(encoder, wav_bytes)
        except Exception as e:
            print(f'{speaker_id}: embedding failed — {e}', file=sys.stderr)
            continue

        # Find best match
        best_name  = None
        best_score = 0.0
        for name, ref_emb in embeddings.items():
            score = cosine_similarity(embedding, ref_emb)
            if score > best_score:
                best_score = score
                best_name  = name

        # Threshold: cosine similarity > 0.75 = confident match
        if best_score >= 0.75:
            result[speaker_id] = {'name': best_name, 'confidence': round(best_score, 3)}
            print(f'{speaker_id} → {best_name} ({best_score:.3f})', file=sys.stderr)
        else:
            print(f'{speaker_id} → unidentified (best: {best_name} @ {best_score:.3f})', file=sys.stderr)

    print(json.dumps(result))

def cmd_list():
    profiles  = load_profiles()
    embeddings = load_embeddings()
    output = []
    for name, data in profiles.items():
        output.append({
            'name': name,
            'enrolled_at': data.get('enrolled_at', '—'),
            'has_embedding': name in embeddings,
        })
    print(json.dumps(output))

def cmd_delete(name):
    profiles  = load_profiles()
    embeddings = load_embeddings()
    removed = False
    if name in profiles:
        del profiles[name]
        save_profiles(profiles)
        removed = True
    if name in embeddings:
        del embeddings[name]
        save_embeddings(embeddings)
        removed = True
    print(json.dumps({'deleted': removed, 'name': name}))

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''

    if cmd == 'enroll' and len(sys.argv) >= 4:
        cmd_enroll(sys.argv[2], sys.argv[3])
    elif cmd == 'identify' and len(sys.argv) >= 4:
        cmd_identify(sys.argv[2], sys.argv[3])
    elif cmd == 'list':
        cmd_list()
    elif cmd == 'delete' and len(sys.argv) >= 3:
        cmd_delete(sys.argv[2])
    else:
        print('Usage:')
        print('  python3 voice-identify.py enroll "Name" /path/to/audio.m4a')
        print('  python3 voice-identify.py identify /path/to/audio.m4a /path/to/segments.json')
        print('  python3 voice-identify.py list')
        print('  python3 voice-identify.py delete "Name"')
