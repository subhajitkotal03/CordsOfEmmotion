"""Inference with the user's existing seven-class Keras emotion model."""

from pathlib import Path
import cv2
import numpy as np
import tensorflow as tf

EMOTION_LABELS = {
    0: "angry",
    1: "disgust",
    2: "fear",
    3: "happy",
    4: "neutral",
    5: "sad",
    6: "surprise",
}
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "bmp"}


class ModelUnavailableError(RuntimeError):
    pass

class NoFaceDetectedError(ValueError):
    pass

class InvalidImageError(ValueError):
    pass

class EmotionDetector:
    def __init__(self, model_path: str | Path):
        self.model_path = Path(model_path)
        if not self.model_path.is_file():
            raise ModelUnavailableError(f"Emotion model was not found: {self.model_path}")
        try:
            self.model = tf.keras.models.load_model(self.model_path, compile=False)
        except Exception as exc:
            raise ModelUnavailableError(f"Could not load the emotion model: {exc}") from exc
        if tuple(self.model.input_shape[1:]) != (48, 48, 1):
            raise ModelUnavailableError(
                f"Expected model input (None, 48, 48, 1), got {self.model.input_shape}."
            )
        if tuple(self.model.output_shape[1:]) != (7,):
            raise ModelUnavailableError(
                f"Expected model output (None, 7), got {self.model.output_shape}."
            )
        self.uses_softmax = self._final_activation_name() == "softmax"
        cascade_factory = getattr(cv2, "CascadeClassifier", None)
        if cascade_factory is None:
            raise ModelUnavailableError(
                "This OpenCV build does not include Haar Cascade support. "
                "Install the pinned dependencies from requirements.txt (OpenCV 4.x)."
            )
        cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        self.face_cascade = cascade_factory(str(cascade_path))
        if self.face_cascade.empty():
            raise ModelUnavailableError("OpenCV could not load its frontal face detector.")

    def _final_activation_name(self):
        activation = getattr(self.model.layers[-1], "activation", None)
        return getattr(activation, "__name__", "unknown")

    def predict_image(self, image_bytes: bytes, filename: str = "capture.jpg"):
        extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if extension not in ALLOWED_IMAGE_EXTENSIONS:
            raise InvalidImageError("Use a JPG, PNG, WEBP or BMP image.")
        encoded = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if image is None or image.size == 0:
            raise InvalidImageError("The selected file is not a readable image.")
        height, width = image.shape[:2]
        if max(height, width) > 3000:
            scale = 3000 / max(height, width)
            image = cv2.resize(image, (int(width * scale), int(height * scale)))
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces = self.face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40)
        )
        if len(faces) == 0:
            raise NoFaceDetectedError("No face found. Try a clear, front-facing image with good lighting.")
        x, y, face_width, face_height = max(faces, key=lambda box: box[2] * box[3])
        face = gray[y:y + face_height, x:x + face_width]
        face = cv2.resize(face, (48, 48), interpolation=cv2.INTER_AREA)
        model_input = (face.astype(np.float32) / 255.0)[np.newaxis, ..., np.newaxis]
        output = np.asarray(self.model.predict(model_input, verbose=0), dtype=np.float32).reshape(-1)
        if output.shape != (7,) or not np.all(np.isfinite(output)):
            raise ModelUnavailableError("The model returned invalid prediction scores.")
        index = int(np.argmax(output))
        return {
            "emotion": EMOTION_LABELS[index],
            "scores": {EMOTION_LABELS[i]: float(output[i]) for i in range(7)},
            "confidence": float(output[index]) if self.uses_softmax else None,
            "confidence_valid": self.uses_softmax,
            "score_type": "probability" if self.uses_softmax else "raw score",
        }
