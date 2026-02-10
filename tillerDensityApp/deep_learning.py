import os
import numpy as np
import requests
from sklearn.preprocessing import StandardScaler
from django.conf import settings
from .rs_indices import indices_calculator, FEATURE_ORDER_21

_MODEL = None


def _model_path():
    return os.getenv(
        "HLS_MODEL_PATH",
        os.path.join(settings.BASE_DIR, "tillerDensityModel", "PS_1DCNN_best_model.h5"),
    )


def _legacy_infer_url():
    return os.getenv("LEGACY_INFER_URL", "").strip()


def _legacy_infer_timeout():
    return int(os.getenv("LEGACY_INFER_TIMEOUT", "120"))


def get_model():
    """Lazily load and cache the Keras model."""
    global _MODEL
    if _MODEL is None:
        import tensorflow as tf
        _MODEL = tf.keras.models.load_model(_model_path())
    return _MODEL


def prepare_features(clipped_image):
    """
    Accepts a rasterio clip array of shape (bands, h, w), builds a
    PS-compatible 21-feature vector per pixel, and returns
    (num_pixels, 21), height, width.
    """
    bands, height, width = clipped_image.shape
    if bands != 6:
        raise ValueError(f"Expected 6-band HLS input, got {bands} bands.")

    # Convert to (h, w, bands) for index calculation helpers.
    clipped_image_hwc = np.transpose(clipped_image, (1, 2, 0))
    features_dict = indices_calculator(clipped_image_hwc)
    band_names = list(features_dict.keys())

    if band_names != FEATURE_ORDER_21:
        raise ValueError(
            f"Feature order mismatch. Expected {FEATURE_ORDER_21}, got {band_names}."
        )

    stacked_array = np.stack([features_dict[name] for name in FEATURE_ORDER_21], axis=0)
    feature_input = stacked_array.reshape(stacked_array.shape[0], -1).T.astype(np.float32)
    return feature_input, height, width


def predict_density(feature_input, height, width):
    """
    Scales features, runs the model, and reshapes back to (height, width).
    """
    legacy_url = _legacy_infer_url()
    if legacy_url:
        payload = {"feature_input": feature_input.tolist()}
        try:
            response = requests.post(
                legacy_url,
                json=payload,
                timeout=_legacy_infer_timeout(),
            )
            response.raise_for_status()
            body = response.json()
        except requests.RequestException as exc:
            raise RuntimeError(f"Legacy inference request failed: {exc}") from exc

        if body.get("status") != "success":
            raise RuntimeError(f"Legacy inference error: {body.get('error', 'unknown')}")

        preds = np.array(body.get("predictions", []), dtype=np.float32)
        expected_size = int(height) * int(width)
        if preds.size != expected_size:
            raise ValueError(
                f"Legacy inference returned {preds.size} predictions, "
                f"expected {expected_size} for output shape ({height}, {width})."
            )
        return preds.reshape(height, width)

    # Fallback path for local in-process model inference.
    scaler = StandardScaler()
    scaler.fit(feature_input)
    scaled_feature_input = scaler.transform(feature_input)

    model = get_model()
    model_input_shape = model.input_shape
    if isinstance(model_input_shape, list):
        model_input_shape = model_input_shape[0]
    if model_input_shape is None or len(model_input_shape) != 3:
        raise ValueError(f"Unsupported model input shape: {model_input_shape}")

    expected_steps = model_input_shape[1]
    expected_channels = model_input_shape[2]
    num_samples, num_features = scaled_feature_input.shape

    # PS-style model: (batch, 21, 1)
    if expected_steps == num_features and expected_channels == 1:
        feature_reshape = scaled_feature_input.reshape(num_samples, num_features, 1)
    # Rare variant: (batch, 1, features)
    elif expected_steps == 1 and expected_channels == num_features:
        feature_reshape = scaled_feature_input.reshape(num_samples, 1, num_features)
    # Legacy HLS model fallback: (batch, 4, 6)
    elif expected_steps == 4 and expected_channels == 6 and num_features == 6:
        feature_reshape = scaled_feature_input.reshape(num_samples, 1, 6)
        feature_reshape = np.repeat(feature_reshape, 4, axis=1)
    else:
        raise ValueError(
            f"Model expects ({expected_steps}, {expected_channels}) but "
            f"provided features shape is ({num_features})."
        )

    preds = model.predict(feature_reshape)
    return preds.reshape(height, width)
