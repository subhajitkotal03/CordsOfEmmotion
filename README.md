# CordsOfEmmotion

CordsOfEmmotion estimates a facial expression locally with a Keras emotion-detection model and discovers mood-matched songs on Spotify. Start your webcam for automatic face scanning or upload a portrait photo, then stream recommended tracks directly in the embedded Spotify player or refresh for a new set.

> Facial expression estimates are approximate and images are processed in memory only—captured frames and uploaded photos are never saved to disk.

## Features

- **Automatic webcam capture or photo upload**: Continuously scans webcam frames until a face is detected, or accepts `JPG`, `PNG`, `WEBP`, and `BMP` uploads (up to 8 MB).
- **On-device emotion detection**: Uses OpenCV Haar Cascade face detection and a 7-class Keras CNN (`48x48` grayscale) to classify `angry`, `disgust`, `fear`, `happy`, `neutral`, `sad`, and `surprise`.
- **Mood-matched Spotify discovery**: Searches Spotify via the server-side Client Credentials flow and returns up to 10 tracks per configured language (`Hindi` and `English` by default in `SpotifyService.LANGUAGES`), with pagination via **Refresh set**.
- **Embedded playback**: Play tracks directly on the page using Spotify's IFrame embed or open them in Spotify.

## Prerequisites

- Windows 10 / 11 (or compatible Python environment)
- Python 3.10 (64-bit)
- A trained 7-class Keras model file placed at `models/emotiondetector.h5` (expects input `(None, 48, 48, 1)` and output `(None, 7)`)
- A Spotify app **Client ID** and **Client Secret** from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
- Internet access for Spotify API requests and the Spotify embedded player

## Project Structure

```text
CordsOfEmmotion/
├── app/
│   ├── __init__.py          # Flask app factory & configuration
│   ├── emotion_detector.py  # OpenCV face detection + Keras inference
│   ├── routes.py            # Web & JSON API endpoints
│   └── spotify_service.py   # Spotify Client Credentials & track search
├── models/                  # Place emotiondetector.h5 here (ignored by Git)
├── static/
│   ├── css/style.css        # Dashboard styling
│   └── js/app.js            # Webcam capture, API calls & Spotify embed
├── templates/
│   └── index.html           # CordsOfEmmotion web UI
├── .env.example             # Sample environment variables
├── .gitignore               # Excludes .venv, .env secrets, and model files
├── requirements.txt         # Python dependencies
└── run.py                   # Local server entry point (port 8000)
```

## Setup & Configuration

### 1. Create a virtual environment and install dependencies

```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Add the emotion model

Place your trained Keras model file at:

```text
models/emotiondetector.h5
```

Or specify a custom path with `CORDSOFEMMOTION_MODEL_PATH` in `.env`.

### 3. Configure Spotify credentials

Copy `.env.example` to `.env` in the project root and fill in your Spotify credentials:

```dotenv
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_MARKET=IN
```

Optional environment variables:

- `FLASK_SECRET_KEY` — custom Flask session secret key
- `CORDSOFEMMOTION_MODEL_PATH` — custom path to your `.h5` or `.keras` model file

The app uses Spotify's server-to-server Client Credentials flow. Credentials stay in `.env` on the server and are never exposed to the browser or committed to Git.

## Run Locally

```powershell
.\.venv\Scripts\python.exe .\run.py
```

Open <http://127.0.0.1:8000> in your browser. Webcam access requires `localhost` (`127.0.0.1`) or HTTPS.

## API Routes

- `GET /` — CordsOfEmmotion dashboard
- `GET /api/health` — Model load status and Spotify configuration check
- `POST /api/detect-emotion` — Predict facial expression from an uploaded `image` file (`multipart/form-data`)
- `POST /api/recommend` — Fetch mood-matched Spotify tracks; accepts JSON body such as `{"emotion": "happy", "page": 0}` (increments `page` to refresh results)

## Troubleshooting

- **Spotify credentials error**: Verify `.env` exists in the project root with valid `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` values, then restart the server.
- **Model unavailable**: Check `GET /api/health` and ensure `models/emotiondetector.h5` exists and matches the `(48, 48, 1)` input / `(7,)` output shape.
