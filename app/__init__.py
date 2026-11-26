"""CordsOfEmmotion Flask application factory."""

import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template

from app.emotion_detector import EmotionDetector
from app.routes import api

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def create_app():
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config.update(
        SECRET_KEY=os.getenv("FLASK_SECRET_KEY", "local-cordsofemmotion-development-key"),
        TEMPLATES_AUTO_RELOAD=True,
        MAX_CONTENT_LENGTH=8 * 1024 * 1024,
        MODEL_PATH=Path(os.getenv("CORDSOFEMMOTION_MODEL_PATH", BASE_DIR / "models" / "emotiondetector.h5")),
        SPOTIFY_CLIENT_ID=os.getenv("SPOTIFY_CLIENT_ID"),
        SPOTIFY_CLIENT_SECRET=os.getenv("SPOTIFY_CLIENT_SECRET"),
        SPOTIFY_MARKET=os.getenv("SPOTIFY_MARKET", "IN"),
    )
    app.config["MODEL_ERROR"] = None
    try:
        app.extensions["emotion_detector"] = EmotionDetector(app.config["MODEL_PATH"])
    except Exception as exc:
        # Keep the dashboard and health endpoint available so setup problems are visible.
        app.config["MODEL_ERROR"] = str(exc)
        app.logger.exception("Emotion model initialization failed")
        app.extensions["emotion_detector"] = None
    app.register_blueprint(api, url_prefix="/api")

    @app.get("/")
    def dashboard():
        return render_template("index.html")

    @app.errorhandler(413)
    def too_large(_error):
        return jsonify(error="Image is too large. Please choose an image under 8 MB."), 413

    return app
