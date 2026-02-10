import numpy as np


def evi_calculation(NIR, RED, BLUE):
    """Enhanced Vegetation Index."""
    G = 2.5
    C1 = 6
    C2 = 7.5
    L = 1
    return G * ((NIR - RED) / (NIR + C1 * RED - C2 * BLUE + L))


FEATURE_ORDER_21 = [
    "B",        # Blue
    "G1",       # Mapped from SWIR1
    "G",        # Green
    "Y",        # Mapped from SWIR2
    "R",        # Red
    "RE",       # Proxy slot from extra index (NIRv)
    "NIR",      # NIR
    "NDVI",
    "EVI",
    "GNDVI",
    "SAVI",
    "NDRE",     # Proxy index using NDMI formula due missing red-edge band
    "MSAVI",
    "GCI",
    "RVI_1",
    "RGVI",
    "NDWI",
    "RVI_2",
    "SIPI",
    "NEXG",
    "NGRDI",
]


def _sanitize(arr, fill_value):
    out = np.asarray(arr, dtype=np.float32)
    out[~np.isfinite(out)] = fill_value
    return out


def indices_calculator(input_image):
    """
    Build a PS-compatible 21-feature set from a 6-band HLS stack.
    Expected input band order: [B, G, R, NIR, SWIR1, SWIR2].
    """
    indices_layers = {}
    fill_value = -9999

    B = input_image[:, :, 0]
    G = input_image[:, :, 1]
    R = input_image[:, :, 2]
    NIR = input_image[:, :, 3]
    SWIR1 = input_image[:, :, 4]
    SWIR2 = input_image[:, :, 5]

    # Core vegetation indices used both directly and for slot mapping.
    with np.errstate(divide="ignore", invalid="ignore"):
        NDVI = (NIR - R) / (NIR + R)
    NDVI = _sanitize(NDVI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        EVI = (NIR - R) / (NIR + 6.0 * R - 7.5 * B + 1.0)
    EVI = _sanitize(EVI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        GNDVI = (NIR - G) / (NIR + G)
    GNDVI = _sanitize(GNDVI, fill_value)

    L_val = 0.5
    with np.errstate(divide="ignore", invalid="ignore"):
        SAVI = ((NIR - R) / (NIR + R + L_val)) * (1.0 + L_val)
    SAVI = _sanitize(SAVI, fill_value)

    # NDMI is used as NDRE proxy because HLS stack has no red-edge band.
    with np.errstate(divide="ignore", invalid="ignore"):
        NDMI = (NIR - SWIR1) / (NIR + SWIR1)
    NDMI = _sanitize(NDMI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        MSAVI = 0.5 * (
            (2.0 * NIR) + 1.0 - np.sqrt(np.square((2.0 * NIR) + 1.0) - 8.0 * (NIR - R))
        )
    MSAVI = _sanitize(MSAVI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        GCI = (NIR / G) - 1.0
    GCI = _sanitize(GCI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        RVI_1 = NIR / R
    RVI_1 = _sanitize(RVI_1, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        RGVI = R / G
    RGVI = _sanitize(RGVI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        NDWI = (G - NIR) / (G + NIR)
    NDWI = _sanitize(NDWI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        RVI_2 = NIR / G
    RVI_2 = _sanitize(RVI_2, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        SIPI = (NIR - B) / (NIR + R)
    SIPI = _sanitize(SIPI, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        NEXG = (2.0 * G - R - B) / (G + R + B)
    NEXG = _sanitize(NEXG, fill_value)

    with np.errstate(divide="ignore", invalid="ignore"):
        NGRDI = (G - R) / (G + R)
    NGRDI = _sanitize(NGRDI, fill_value)

    # Extra index used to fill the red-edge raw slot.
    # NIRv keeps a chlorophyll/canopy-vigor style signal without red-edge band.
    NIRv = _sanitize(NIR * NDVI, fill_value)

    # Raw-slot mapping (PS schema -> available HLS signals).
    indices_layers["B"] = _sanitize(B, fill_value)
    indices_layers["G1"] = _sanitize(SWIR1, fill_value)
    indices_layers["G"] = _sanitize(G, fill_value)
    indices_layers["Y"] = _sanitize(SWIR2, fill_value)
    indices_layers["R"] = _sanitize(R, fill_value)
    indices_layers["RE"] = NIRv
    indices_layers["NIR"] = _sanitize(NIR, fill_value)

    # Index slots in the same order as the prior PS feature layout.
    indices_layers["NDVI"] = NDVI
    indices_layers["EVI"] = EVI
    indices_layers["GNDVI"] = GNDVI
    indices_layers["SAVI"] = SAVI
    indices_layers["NDRE"] = NDMI
    indices_layers["MSAVI"] = MSAVI
    indices_layers["GCI"] = GCI
    indices_layers["RVI_1"] = RVI_1
    indices_layers["RGVI"] = RGVI
    indices_layers["NDWI"] = NDWI
    indices_layers["RVI_2"] = RVI_2
    indices_layers["SIPI"] = SIPI
    indices_layers["NEXG"] = NEXG
    indices_layers["NGRDI"] = NGRDI

    # Guard against accidental order drift.
    if list(indices_layers.keys()) != FEATURE_ORDER_21:
        raise ValueError("Feature order mismatch for PS-compatible 21-feature schema.")

    return indices_layers
