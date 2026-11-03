#!/usr/bin/env python3
"""Generate background-music options with Lyria on Vertex AI.

Usage: music.py   -> video/music/option-{1,2,3}.wav and video/music/index.html

Each clip is ~33 s of 48 kHz stereo; narrate.py --music loops one under the
voice and ducks it. Project: gke-demos-345619 (Lyria enabled there).
"""
import base64, json, os, subprocess, urllib.request

PROJECT = "gke-demos-345619"
URL = ("https://us-central1-aiplatform.googleapis.com/v1/projects/" + PROJECT
       + "/locations/us-central1/publishers/google/models/lyria-002:predict")
NEGATIVE = "vocals, singing, harsh drums, distortion, dramatic build-ups, sudden changes"
OPTIONS = [
    ("option-1", "calm modern electronic ambient bed for a technology product demo voiceover, soft pulsing synth pads, "
                 "gentle steady rhythm, optimistic, warm, unobtrusive, no vocals", 11),
    ("option-2", "minimal light tech underscore, soft plucked arpeggios over warm pads, steady mid tempo, "
                 "clean and focused, sits under narration, no vocals", 23),
    ("option-3", "subtle lo-fi electronic background, mellow keys and soft beat, relaxed and confident, "
                 "even dynamics for a narrated walkthrough, no vocals", 37),
]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "music")


def main():
    os.makedirs(OUT, exist_ok=True)
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()
    rows = []
    for name, prompt, seed in OPTIONS:
        path = os.path.join(OUT, name + ".wav")
        if not os.path.exists(path):
            body = json.dumps({"instances": [{"prompt": prompt, "negative_prompt": NEGATIVE, "seed": seed}]}).encode()
            req = urllib.request.Request(URL, data=body, headers={
                "Authorization": "Bearer " + token, "Content-Type": "application/json"})
            pred = json.load(urllib.request.urlopen(req, timeout=180))["predictions"][0]
            open(path, "wb").write(base64.b64decode(pred["bytesBase64Encoded"]))
        print("wrote", path)
        rows.append(f"<h3>{name}</h3><p>{prompt}</p><audio controls src='{name}.wav'></audio>")
    open(os.path.join(OUT, "index.html"), "w").write(
        "<!doctype html><meta charset=utf-8><title>Music options</title><body style='font-family:sans-serif;max-width:800px'>"
        "<h1>fleet-scope video: music options</h1>" + "".join(rows))


if __name__ == "__main__":
    main()
