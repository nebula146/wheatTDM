import os

import numpy as np
import tensorflow as tf
from flask import Flask, jsonify, request


app = Flask(__name__)
_MODEL = None


def model_path():
    return os.getenv("LEGACY_MODEL_PATH", "/models/PS_1DCNN_best_model.h5")


def get_model():
    global _MODEL
    if _MODEL is None:
        path = model_path()
        if not os.path.exists(path):
            raise FileNotFoundError(f"Legacy model file not found: {path}")
        _MODEL = tf.keras.models.load_model(path, compile=False)
    return _MODEL


def scale_features(feature_input):
    means = np.mean(feature_input, axis=0, keepdims=True)
    stds = np.std(feature_input, axis=0, keepdims=True)
    stds = np.where(stds == 0.0, 1.0, stds)
    return (feature_input - means) / stds


def reshape_for_model(feature_input, model):
    model_input_shape = model.input_shape
    if isinstance(model_input_shape, list):
        model_input_shape = model_input_shape[0]
    if model_input_shape is None or len(model_input_shape) != 3:
        raise ValueError(f"Unsupported model input shape: {model_input_shape}")

    expected_steps = model_input_shape[1]
    expected_channels = model_input_shape[2]
    num_samples, num_features = feature_input.shape

    if expected_steps == num_features and expected_channels == 1:
        return feature_input.reshape(num_samples, num_features, 1)
    if expected_steps == 1 and expected_channels == num_features:
        return feature_input.reshape(num_samples, 1, num_features)
    if expected_steps == 4 and expected_channels == 6 and num_features == 6:
        reshaped = feature_input.reshape(num_samples, 1, 6)
        return np.repeat(reshaped, 4, axis=1)

    raise ValueError(
        f"Model expects ({expected_steps}, {expected_channels}) but "
        f"provided feature shape is ({num_features})."
    )


@app.route("/health", methods=["GET"])
def health():
    try:
        model = get_model()
        return jsonify(
            {
                "status": "ok",
                "model_path": model_path(),
                "model_input_shape": model.input_shape,
            }
        )
    except Exception as exc:
        return jsonify({"status": "error", "error": str(exc)}), 500


@app.route("/predict", methods=["POST"])
def predict():
    try:
        payload = request.get_json(silent=True) or {}
        raw_features = payload.get("feature_input")
        if raw_features is None:
            return jsonify({"status": "error", "error": "Missing field 'feature_input'."}), 400

        feature_input = np.asarray(raw_features, dtype=np.float32)
        if feature_input.ndim != 2:
            return (
                jsonify(
                    {
                        "status": "error",
                        "error": f"feature_input must be a 2D array, got ndim={feature_input.ndim}.",
                    }
                ),
                400,
            )

        scaled = scale_features(feature_input)
        model = get_model()
        model_ready = reshape_for_model(scaled, model)
        preds = model.predict(model_ready, verbose=0)

        return jsonify(
            {
                "status": "success",
                "predictions": preds.reshape(-1).astype(np.float32).tolist(),
            }
        )
    except Exception as exc:
        return jsonify({"status": "error", "error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
