"""JSON endpoints for emotion detection and music search."""

from flask import Blueprint, current_app, jsonify, request

from app.emotion_detector import InvalidImageError, ModelUnavailableError, NoFaceDetectedError
from app.spotify_service import SpotifyError, SpotifyService

api = Blueprint("api", __name__)


def _spotify():
    service = current_app.extensions.get("spotify_service")
    if service is None:
        service = SpotifyService(
            current_app.config.get("SPOTIFY_CLIENT_ID"),
            current_app.config.get("SPOTIFY_CLIENT_SECRET"),
            current_app.config.get("SPOTIFY_MARKET", "IN"),
        )
        current_app.extensions["spotify_service"] = service
    return service


@api.get("/health")
def health():
    detector = current_app.extensions.get("emotion_detector")
    return jsonify(
        status="ok" if detector else "degraded",
        model_loaded=detector is not None,
        model_error=current_app.config.get("MODEL_ERROR"),
        music_service="Spotify",
        spotify_configured=bool(
            current_app.config.get("SPOTIFY_CLIENT_ID")
            and current_app.config.get("SPOTIFY_CLIENT_SECRET")
        ),
    ), 200


@api.post("/detect-emotion")
def detect_emotion():
    detector = current_app.extensions.get("emotion_detector")
    if detector is None:
        return jsonify(error="The emotion model is unavailable. Check /api/health for startup details."), 503
    uploaded = request.files.get("image")
    if uploaded is None or not uploaded.filename:
        return jsonify(error="Choose an image or capture a webcam frame first."), 400
    try:
        result = detector.predict_image(uploaded.read(), uploaded.filename)
    except NoFaceDetectedError as exc:
        return jsonify(error=str(exc), code="no_face"), 422
    except InvalidImageError as exc:
        return jsonify(error=str(exc), code="invalid_image"), 400
    except ModelUnavailableError as exc:
        current_app.logger.exception("Model inference failed")
        return jsonify(error=str(exc)), 500
    return jsonify(result)


@api.post("/recommend")
def recommend():
    payload = request.get_json(silent=True) or {}
    emotion = (payload.get("emotion") or "").strip().lower()
    if emotion and emotion not in SpotifyService.EMOTION_QUERIES:
        return jsonify(error="Unsupported emotion."), 400
    try:
        page = min(max(int(payload.get("page", 0)), 0), 99)
        service = _spotify()
        tracks = service.get_language_tracks(page, emotion=emotion or None)
    except (TypeError, ValueError):
        return jsonify(error="Song page must be a whole number."), 400
    except SpotifyError as exc:
        return jsonify(error=str(exc)), 502
    return jsonify(
        emotion=emotion or None,
        languages=list(service.LANGUAGES),
        page=page,
        tracks=tracks,
        count=len(tracks),
    )
