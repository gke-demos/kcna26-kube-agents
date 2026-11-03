#!/usr/bin/env python3
"""Narrated cut of the fleet-scope walkthrough (video/record.mjs): Google Cloud TTS (Chirp 3 HD) over the recorded takes.

Each narration cue belongs to a scene (a marker in out/markers*.json) and starts
with it. A cue may run on over the following scenes. If the previous cue is
still playing when a scene starts, its cue waits, as long as it still fits in
its own scene. Only when it doesn't is the previous scene's last frame held, so
speech is never cut off or overlapped. Captions stay on screen as titles.

  python3 narrate.py full  [--music music/ambient-1.wav]  -> out/demo-narrated.mp4
  --music none leaves the music out.

Music: one generated clip (Lyria, music/*.wav) looped with crossfades into a
bed as long as the video, kept low and ducked under the narration with a
sidechain compressor.

Spelling is phonetic where TTS mangles names: "cube agents", "G K E", "fleet scope".
Synthesized clips are cached in out/tts/ by voice and text.
"""
import argparse, base64, hashlib, json, os, subprocess, urllib.request

D = os.environ.get("DEMO_OUT") or os.path.join(os.getcwd(), "out")
PROJECT = "gke-demos-345619"
VOICE = {"languageCode": "en-AU", "name": "en-AU-Chirp3-HD-Kore"}
PAD = 0.5  # silence after a cue before the next scene may start

# Unused here (the original demo inserted a controls-tour scene after 'scene').
TOUR_OFFSET = 0.0
TRIM_IN = {}
MUSIC_GAIN = 0.60      # music level when nobody is speaking (linear): about -29 dB mean, 12 dB under the voice
MUSIC_XFADE = 4.0      # crossfade between loops of the clip, seconds

CUES = {
    "title": "Cube agents, running a G K E fleet, in real time.",
    "fleet": "This is fleet scope: every cluster and every workload in our demo fleet, drawn from the clusters themselves. "
             "Online Boutique, Bank of Anthos, and the hub where the agents run.",
    "agents": "Below the fleet are the agents: a Planning Agent that takes requests, a Platform Agent that does the work, "
              "and a read-only Cluster Agent for each cluster. Alerts and answers go out through Slack.",
    "workload": "Click any workload for its health, replicas, image and memory limit, and the Cluster Agent watching it.",
    "feed": "On the left is the fleet's activity: alerts, the agents' notes, the overnight audits and the pull requests they opened, "
            "each one linking back to Slack or GitHub.",
    "press": "Now let's break something, the way it really happens: a commit that rolls out an image tag that doesn't exist. "
             "The console starts tracking it straight away.",
    "sync-and-fail": "Config Sync applies the change, and the new pods can't pull their image.",
    "alert": "The event watcher spots it and raises an alert in Slack. A missing tag never fixes itself, so there's nothing to wait for.",
    "investigate": "A Cluster Agent investigates, with read-only access to that one cluster. "
                   "Its notes stream into the Slack thread, and we follow the same thread right here.",
    "report": "Here's the diagnosis: what's wrong, why, and the options, with the recommended fix highlighted. "
              "The evidence, the exact commands it ran, folds away underneath.",
    "pr": "The agent opens its recommended fix as a pull request against the fleet repo. Nothing changes on the cluster until a person approves it.",
    "merge": "A person reviews it, and merges.",
    "heal": "Config Sync applies the fix, and the workload heals. Every step, from the bad change to the fix, is a commit you can audit.",
    "reset": "And one button puts the demo back, ready for the next run.",
    "end": "Cube agents. Find it on GitHub, at G K E labs, slash cube agents.",
}
VARIANTS = {
    "full": {"out": "demo-narrated.mp4", "drop": set(), "cues": {}},
}


def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).strip())


def tts(text):
    os.makedirs(os.path.join(D, "tts"), exist_ok=True)
    key = hashlib.sha1((VOICE["name"] + "\n" + text).encode()).hexdigest()[:16]
    path = os.path.join(D, "tts", f"{key}.wav")
    if os.path.exists(path):
        return path
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()
    body = json.dumps({"input": {"text": text}, "voice": VOICE,
                       "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 48000}}).encode()
    req = urllib.request.Request("https://texttospeech.googleapis.com/v1/text:synthesize", data=body, headers={
        "Authorization": f"Bearer {token}", "x-goog-user-project": PROJECT, "Content-Type": "application/json"})
    audio = json.load(urllib.request.urlopen(req, timeout=60))["audioContent"]
    open(path, "wb").write(base64.b64decode(audio))
    return path


def spans_from_takes():
    takes = [("raw.webm", "markers.json")] + sorted(
        (f, "markers-" + f[len("raw-"):-len(".webm")] + ".json") for f in os.listdir(D) if f.startswith("raw-") and f.endswith(".webm"))
    takes = [(r, mk) for r, mk in takes if os.path.exists(os.path.join(D, r)) and os.path.exists(os.path.join(D, mk))]
    per_take = []
    for ti, (r, mk) in enumerate(takes):
        spans = []
        m = json.load(open(os.path.join(D, mk)))["markers"]
        if any(x["name"] == "scene" for x in m) and not any(x["name"] == "tour" for x in m):
            i = next(i for i, x in enumerate(m) if x["name"] == "scene")
            m.insert(i + 1, {"name": "tour", "t": m[i]["t"] + TOUR_OFFSET, "speed": 1})
        end = duration(os.path.join(D, r))
        for i, x in enumerate(m):
            start, stop = x["t"], (m[i + 1]["t"] if i + 1 < len(m) else end)
            if x["name"] in ("error", "done") or stop - start <= 0.05:
                continue
            start = min(start + TRIM_IN.get(x["name"], 0.0), stop)
            spans.append((ti, x["name"], start, min(stop, end), x.get("speed", 1)))
        per_take.append(spans)
    # A retaken scene replaces the main take's scene of the same name, in place;
    # scenes the main take doesn't have are appended.
    spans = list(per_take[0]) if per_take else []
    for retake in per_take[1:]:
        for sp in retake:
            idx = next((i for i, x in enumerate(spans) if x[1] == sp[1] and x[0] == 0), None)
            if idx is None:
                spans.append(sp)
            else:
                spans[idx] = sp
    return takes, spans


def music_bed(clip, total):
    """Loop clip with crossfades until it covers total seconds; returns a WAV path."""
    clen = duration(clip)
    n = max(1, int((total + MUSIC_XFADE) // (clen - MUSIC_XFADE)) + 1)
    out = os.path.join(D, f"bed-{os.path.splitext(os.path.basename(clip))[0]}-{int(total)}.wav")
    if n == 1:
        subprocess.check_call(["ffmpeg", "-y", "-v", "error", "-i", clip, "-t", f"{total:.3f}", out])
        return out
    args = [a for _ in range(n) for a in ("-i", clip)]
    chain, prev = [], "[0:a]"
    for k in range(1, n):
        lab = f"[x{k}]" if k < n - 1 else "[bed]"
        chain.append(f"{prev}[{k}:a]acrossfade=d={MUSIC_XFADE}:c1=tri:c2=tri{lab}")
        prev = lab
    subprocess.check_call(["ffmpeg", "-y", "-v", "error", *args, "-filter_complex", ";".join(chain),
                           "-map", "[bed]", "-t", f"{total:.3f}", out])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("variant", nargs="?", default="full", choices=sorted(VARIANTS))
    ap.add_argument("--music", default="none", help="a WAV clip to loop under the narration, or none")
    a = ap.parse_args()
    cfg = VARIANTS[a.variant]
    takes, spans = spans_from_takes()
    spans = [s for s in spans if s[1] not in cfg["drop"]]

    cues = {**CUES, **cfg["cues"]}
    vlens = [(e - s) / sp for _, _, s, e, sp in spans]
    clips = [tts(cues[name]) if name in cues else None for _, name, _, _, _ in spans]
    alens = [duration(c) if c else 0.0 for c in clips]

    # Timeline: cue i starts at its scene's start, later if the previous cue is
    # still playing and it still fits; otherwise hold the previous scene.
    holds, cue_at = [0.0] * len(spans), [None] * len(spans)
    t, busy = 0.0, 0.0
    for i in range(len(spans)):
        if clips[i]:
            start = max(t, busy)
            if start - t + alens[i] + PAD > vlens[i] and busy > t and i > 0:
                holds[i - 1] += busy - t
                t = busy
                start = t
            cue_at[i] = start
            busy = start + alens[i] + PAD
        t += vlens[i]
    if busy > t:
        holds[-1] += busy - t
    total = sum(vlens) + sum(holds)

    inputs = [arg for r, _ in takes for arg in ("-i", os.path.join(D, r))]
    filters, vlabels, report = [], [], []
    for i, (ti, name, s, e, speed) in enumerate(spans):
        filters.append(f"[{ti}:v]trim=start={s:.3f}:end={e:.3f},setpts=(PTS-STARTPTS)/{speed},fps=30"
                       + (f",tpad=stop_mode=clone:stop_duration={holds[i]:.3f}" if holds[i] > 0.01 else "") + f"[v{i}]")
        vlabels.append(f"[v{i}]")
        report.append((name, vlens[i], alens[i], holds[i], cue_at[i]))
    alabels = []
    for i, clip in enumerate(clips):
        if not clip:
            continue
        idx = len(takes) + len(alabels)
        inputs += ["-i", clip]
        ms = int(cue_at[i] * 1000)
        filters.append(f"[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[c{i}]")
        alabels.append(f"[c{i}]")
    filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{total:.3f}[silence]")
    voice = f"[silence]{''.join(alabels)}amix=inputs={len(alabels) + 1}:normalize=0:duration=first"
    fade_out = f"afade=t=out:st={max(total - 1.5, 0):.2f}:d=1.5"
    if a.music and a.music != "none":
        inputs += ["-i", music_bed(a.music, total)]
        m = len(takes) + len(alabels)
        audio = (f"{voice},asplit=2[vox][key];"
                 f"[{m}:a]aresample=48000,aformat=channel_layouts=stereo,volume={MUSIC_GAIN},afade=t=in:st=0:d=2[mus];"
                 f"[mus][key]sidechaincompress=threshold=0.015:ratio=6:attack=30:release=600:makeup=1[duck];"
                 f"[duck][vox]amix=inputs=2:normalize=0:duration=first,{fade_out}[aout]")
    else:
        audio = f"{voice},{fade_out}[aout]"
    graph = ";".join(filters) + f";{''.join(vlabels)}concat=n={len(spans)}:v=1:a=0,format=yuv420p," \
        f"fade=t=in:st=0:d=0.6,fade=t=out:st={max(total - 0.8, 0):.2f}:d=0.8[vout];" + audio
    out = os.path.join(D, cfg["out"])
    subprocess.check_call(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
                           "-movflags", "+faststart", out])
    print(f"wrote {out}: {total:.0f}s ({total / 60:.1f} min), voice {VOICE['name']}, music {os.path.basename(a.music) if a.music != 'none' else 'none'}")
    t = 0.0
    for name, vlen, alen, hold, at in report:
        cue = f"voice {alen:5.1f}s at {at:6.1f}s" + (f" (+{at - t:.1f}s late)" if at is not None and at - t > 0.05 else "") if at is not None else ""
        print(f"  {name:16s} @{t:6.1f}s scene {vlen:5.1f}s  {cue}" + (f"  hold +{hold:.1f}s" if hold > 0.01 else ""))
        t += vlen + hold


if __name__ == "__main__":
    main()
