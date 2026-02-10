from django.shortcuts import render
import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_geom
from pyproj import CRS
import json
import numpy as np
from shapely.geometry import shape, mapping, box
from shapely.validation import explain_validity
import shapely.wkt
import io
import base64
import os
from pathlib import Path
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie, csrf_protect
from datetime import datetime, timedelta
from django.conf import settings
from django.http import StreamingHttpResponse
from django.urls import reverse
import re
import matplotlib
from rasterio.io import MemoryFile

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import AutoMinorLocator
from .deep_learning import prepare_features, predict_density

APP_BRANDING = {
    "page_title": "Wheat-TDM v1",
    "topbar_title": "WheatAI",
    "topbar_subtitle": "AI-BASED WHEAT PHENOTYPING PLATFORM",
    "brand_kicker": "WHEAT MONITOR",
    "brand_title": "Wheat-TDM v1",
    "brand_subtitle": "Map-first analytics for field-level decisions",
}


@ensure_csrf_cookie
def index(request):
    return render(request, "TillerDensityApp/index.html", APP_BRANDING)

import ee

_GEE_READY = False
_GEE_LAST_ERROR = None


def initialize_gee():
    """
    Initialize Earth Engine using (in order):
    1) Service account credentials from env vars (GEE_SERVICE_ACCOUNT, GEE_KEY_FILE)
       - If GEE_KEY_FILE is not set, falls back to secrets/gee-key.json when present.
    2) Default local credentials (ee.Initialize()).
    Returns True on success, False otherwise.
    """
    global _GEE_READY, _GEE_LAST_ERROR
    service_account = os.getenv("GEE_SERVICE_ACCOUNT")
    key_file_env = os.getenv("GEE_KEY_FILE")
    project_id = os.getenv("GEE_PROJECT")

    # Resolve key path: env var wins, otherwise use secrets/gee-key.json if it exists
    default_key_path = settings.BASE_DIR / "secrets" / "gee-key.json"
    key_path = Path(key_file_env).expanduser() if key_file_env else None
    if key_path and not key_path.is_absolute():
        key_path = settings.BASE_DIR / key_path
    if not key_path and default_key_path.exists():
        key_path = default_key_path

    try:
        if service_account and not key_path:
            raise FileNotFoundError(
                "GEE_SERVICE_ACCOUNT is set but no key file was found. "
                "Set GEE_KEY_FILE or place secrets/gee-key.json."
            )

        # If a key file exists but no service account was provided, read it from the JSON.
        if not service_account and key_path and key_path.exists():
            with open(key_path, "r", encoding="utf-8") as key_file:
                key_data = json.load(key_file)
            service_account = key_data.get("client_email")
            if not project_id:
                project_id = key_data.get("project_id")
            if not service_account:
                raise ValueError(
                    "GEE key file is missing client_email. "
                    "Set GEE_SERVICE_ACCOUNT explicitly."
                )

        if service_account and key_path:
            if not key_path.exists():
                raise FileNotFoundError(f"GEE key file not found at {key_path}")
            credentials = ee.ServiceAccountCredentials(service_account, str(key_path))
            effective_project = project_id
            try:
                if effective_project:
                    ee.Initialize(credentials, project=effective_project)
                else:
                    ee.Initialize(credentials)
            except Exception as project_error:
                # Some service accounts can access EE but lack serviceusage permissions
                # on the configured Cloud project; retry without forcing project.
                project_msg = str(project_error).lower()
                if effective_project and (
                    "required permission to use project" in project_msg
                    or "serviceusage.services.use" in project_msg
                ):
                    print(
                        f"GEE init with project '{effective_project}' failed due project IAM; "
                        "retrying without explicit project."
                    )
                    ee.Initialize(credentials)
                    effective_project = None
                else:
                    raise
            print(
                f"Initialized GEE with service account credentials. "
                f"project={effective_project or 'default'}"
            )
        else:
            effective_project = project_id
            try:
                if effective_project:
                    ee.Initialize(project=effective_project)
                else:
                    ee.Initialize()
            except Exception as project_error:
                project_msg = str(project_error).lower()
                if effective_project and (
                    "required permission to use project" in project_msg
                    or "serviceusage.services.use" in project_msg
                ):
                    print(
                        f"GEE init with project '{effective_project}' failed due project IAM; "
                        "retrying without explicit project."
                    )
                    ee.Initialize()
                    effective_project = None
                else:
                    raise
            print(
                f"Initialized GEE with default credentials. "
                f"project={effective_project or 'default'}"
            )
        _GEE_READY = True
        _GEE_LAST_ERROR = None
    except Exception as e:
        _GEE_READY = False
        _GEE_LAST_ERROR = str(e)
        print(
            "GEE initialization failed: "
            f"{e} | service_account_set={bool(service_account)} "
            f"| key_path={key_path if key_path else 'unset'} "
            f"| key_exists={key_path.exists() if key_path else False} "
            f"| project={project_id or 'default'}"
        )
    return _GEE_READY


# Attempt initialization; if it fails, we’ll retry on demand in fetch_gee_image.
initialize_gee()

def fetch_gee_image(polygon_geojson, date_str, polygon_crs_epsg=4326):
    """
    Download a 6-band HLS stack (prefers closest-date S30 or L30) for the given ROI
    and date (±window days) and return the local GeoTIFF path. Bands: blue, green,
    red, nir, swir1, swir2.
    """
    try:
        if not _GEE_READY and not initialize_gee():
            raise RuntimeError(
                "Earth Engine initialization failed. "
                f"Details: {_GEE_LAST_ERROR or 'unknown error'}. "
                "Check service account access, GEE key file path, and GEE project configuration."
            )

        # Ensure we are working in EPSG:4326 for Earth Engine
        target_crs_gee = CRS.from_epsg(4326)
        if polygon_crs_epsg != 4326:
            print(f"Reprojecting GEE input polygon from EPSG:{polygon_crs_epsg} to EPSG:4326")
            polygon_geojson = match_crs(target_crs_gee, polygon_geojson, polygon_crs_epsg)
            
        roi = ee.Geometry(polygon_geojson)

        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        window_days = int(os.getenv("HLS_SEARCH_WINDOW_DAYS", "7"))
        start_date = (date_obj - timedelta(days=window_days)).strftime("%Y-%m-%d")
        end_date = (date_obj + timedelta(days=window_days)).strftime("%Y-%m-%d")

        # HLS collections (v002 naming per GEE catalog)
        hls_s30 = ee.ImageCollection("NASA/HLS/HLSS30/v002")
        hls_l30 = ee.ImageCollection("NASA/HLS/HLSL30/v002")

        target_date = ee.Date(date_str)

        def add_diff_and_tag(img, tag):
            # Some HLS assets in GEE can report unbounded geometry, making
            # filterBounds insufficient. Keep only images with actual valid
            # pixels inside the ROI.
            valid_count_raw = img.select("B4").reduceRegion(
                reducer=ee.Reducer.count(),
                geometry=roi,
                scale=30,
                maxPixels=1e8,
                bestEffort=True,
            ).get("B4")
            valid_count = ee.Number(ee.Algorithms.If(valid_count_raw, valid_count_raw, 0))

            cloud_raw = img.get("CLOUD_COVERAGE")
            cloud_score = ee.Number(ee.Algorithms.If(cloud_raw, cloud_raw, 100))

            return img.set(
                {
                    "days_from_target": img.date().difference(target_date, "day").abs(),
                    "hls_product": tag,
                    "valid_pixel_count": valid_count,
                    "cloud_score": cloud_score,
                }
            )

        s30_col = hls_s30.filterBounds(roi).filterDate(start_date, end_date).map(
            lambda img: add_diff_and_tag(img, "S30")
        )
        l30_col = hls_l30.filterBounds(roi).filterDate(start_date, end_date).map(
            lambda img: add_diff_and_tag(img, "L30")
        )

        # Earth Engine sort accepts a single property; chain sorts to emulate multi-key
        dataset = (
            s30_col.merge(l30_col)
            .filter(ee.Filter.gt("valid_pixel_count", 0))
            .sort("cloud_score")            # secondary key
            .sort("days_from_target")       # primary key (applied last)
        )

        if dataset.size().getInfo() == 0:
            raise ValueError(
                f"No HLS images (S30 or L30) with valid pixels over ROI "
                f"between {start_date} and {end_date}."
            )

        image = dataset.first()
        product_used = image.get("hls_product").getInfo()
        image_id = image.get("system:index").getInfo()
        valid_pixels = image.get("valid_pixel_count").getInfo()
        cloud_score = image.get("cloud_score").getInfo()
        print(
            f"Using HLS product: {product_used}, image_id={image_id}, "
            f"valid_pixels={valid_pixels}, cloud={cloud_score}"
        )

        # Note: cloud masking disabled per request; using raw bands.

        scaling = 0.0001
        if product_used == "S30":
            # Sentinel-2 based HLS (v002) band names
            b = image.select("B2").multiply(scaling).rename("B")
            g = image.select("B3").multiply(scaling).rename("G")
            r = image.select("B4").multiply(scaling).rename("R")
            nir = image.select("B8A").multiply(scaling).rename("NIR")
            swir1 = image.select("B11").multiply(scaling).rename("SWIR1")
            swir2 = image.select("B12").multiply(scaling).rename("SWIR2")
        else:  # L30 (Landsat-based HLS v002)
            b = image.select("B2").multiply(scaling).rename("B")
            g = image.select("B3").multiply(scaling).rename("G")
            r = image.select("B4").multiply(scaling).rename("R")
            nir = image.select("B5").multiply(scaling).rename("NIR")
            swir1 = image.select("B6").multiply(scaling).rename("SWIR1")
            swir2 = image.select("B7").multiply(scaling).rename("SWIR2")

        final_image = ee.Image.cat([b, g, r, nir, swir1, swir2]).clip(roi)

        # Compute the correct UTM zone from the ROI's actual location.
        # The HLS tile's native CRS may be a different UTM zone that doesn't
        # cover the ROI (e.g., tile stored in EPSG:32601 but ROI is in zone 14).
        roi_utm_epsg = utm_epsg_from_polygon(polygon_geojson)
        download_crs = f"EPSG:{roi_utm_epsg}"
        print(f"ROI-based UTM projection for download: {download_crs}")

        # Transform ROI to the correct UTM zone for clipping
        roi_utm = roi.transform(ee.Projection(download_crs), 1)

        url = final_image.getDownloadURL(
            {
                "name": "hls_roi",
                "scale": 30,  # native HLS resolution
                "crs": download_crs,
                "region": roi_utm,
            }
        )

        import requests, zipfile, io, rasterio

        response = requests.get(url, timeout=120)
        response.raise_for_status()

        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        base_filename = f"gee_hls_{timestamp}"
        os.makedirs(settings.MEDIA_ROOT, exist_ok=True)
        temp_path = os.path.join(settings.MEDIA_ROOT, f"{base_filename}.tif")

        content_type = response.headers.get("Content-Type", "").lower()
        data = response.content
        looks_like_zip = data[:2] == b"PK"

        stacked = None
        band_profile = None

        if content_type.startswith("application/zip") or looks_like_zip:
            save_debug = os.getenv("GEE_SAVE_TIF", "false").lower() == "true"
            if save_debug:
                zip_path = os.path.join(settings.MEDIA_ROOT, f"{base_filename}.zip")
                with open(zip_path, "wb") as zf_out:
                    zf_out.write(data)

            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                tif_names = [n for n in zf.namelist() if n.lower().endswith(".tif")]
                if not tif_names:
                    raise ValueError("Downloaded ZIP does not contain a .tif file.")

                if len(tif_names) == 1:
                    with zf.open(tif_names[0]) as tif_src, rasterio.open(tif_src) as src:
                        stacked = src.read().astype("float32")
                        band_profile = src.profile
                else:
                    desired_order = ["B", "G", "R", "NIR", "SWIR1", "SWIR2"]
                    band_arrays = []
                    for name in tif_names:
                        with zf.open(name) as tif_src:
                            with rasterio.open(tif_src) as src:
                                data_band = src.read(1)
                                if band_profile is None:
                                    band_profile = src.profile
                                band_arrays.append((name, data_band))

                    if band_profile is None:
                        raise ValueError("Could not read any TIFF bands from ZIP.")

                    def band_index(name):
                        lower = name.lower()
                        for i, key in enumerate(desired_order):
                            if key.lower() in lower:
                                return i
                        return len(desired_order) + 1

                    band_arrays.sort(key=lambda x: band_index(x[0]))
                    stacked = np.stack([arr for _, arr in band_arrays], axis=0).astype("float32")
        else:
            # Single multiband TIFF content
            with rasterio.io.MemoryFile(data) as mem:
                with mem.open() as src:
                    stacked = src.read().astype("float32")
                    band_profile = src.profile

        if stacked is None or band_profile is None:
            raise ValueError("Failed to read HLS download into memory.")

        if np.all(stacked == 0):
            raise ValueError(
                "Downloaded HLS raster contains only zeros. "
                "Likely no valid observation over ROI/date window."
            )

        # Update profile and persist to disk for downstream processing
        band_profile.update(count=stacked.shape[0], dtype="float32", nodata=-9999.0)
        with rasterio.open(temp_path, "w", **band_profile) as dst:
            dst.write(stacked)

        mins = stacked.reshape(stacked.shape[0], -1).min(axis=1)
        maxs = stacked.reshape(stacked.shape[0], -1).max(axis=1)
        print(f"GEE saved {temp_path}, band mins={mins}, maxs={maxs}")

        return temp_path

    except Exception as e:
        print(f"Error fetching GEE image: {e}")
        raise e

def match_crs(raster_crs, polygon_geojson, polygon_crs_epsg):
    polygon_crs = CRS.from_epsg(polygon_crs_epsg)
    print(f'Polygon CRS: {polygon_crs}')
    print(f'Raster CRS: {raster_crs}')


    polygon_shape = shape(polygon_geojson)
    if not polygon_shape.is_valid:
        print("Invalid original polygon geometry:", explain_validity(polygon_shape)) #geometry validation
        
        polygon_shape = polygon_shape.buffer(0)
        if not polygon_shape.is_valid:
            raise ValueError("Original polygon geometry is invalid and could not be fixed.")

    
    if raster_crs != polygon_crs:  #crs transformation(only if required)
        
        reprojected_polygon_geojson = transform_geom(
            src_crs=polygon_crs.to_string(),
            dst_crs=raster_crs.to_string(),
            geom=polygon_geojson,
            antimeridian_cutting=True,
            precision=6
        )

        #back to shapely from json
        reprojected_polygon_shape = shape(reprojected_polygon_geojson) 

        
        if not reprojected_polygon_shape.is_valid:
            print("Invalid transformed polygon geometry:", explain_validity(reprojected_polygon_shape))
            
            reprojected_polygon_shape = reprojected_polygon_shape.buffer(0)
            if not reprojected_polygon_shape.is_valid:
                raise ValueError("Transformed polygon geometry is invalid and could not be fixed.")
            else:
                print("Transformed geometry fixed using buffer(0).")

        # Reduces the precision to mitigate floating-point errors
        reprojected_polygon_shape = shapely.wkt.loads(shapely.wkt.dumps(reprojected_polygon_shape, rounding_precision=6))

        # Update the GeoJSON after fixes
        reprojected_polygon_geojson = mapping(reprojected_polygon_shape)

        # Debugging: Print transformed coordinates
        print("Transformed Polygon Coordinates:", reprojected_polygon_geojson['coordinates'])
    else:
        reprojected_polygon_geojson = polygon_geojson

    return reprojected_polygon_geojson

def utm_epsg_from_polygon(polygon_geojson_wgs84):
    polygon_shape = shape(polygon_geojson_wgs84)
    if not polygon_shape.is_valid:
        print("Invalid WGS84 polygon geometry:", explain_validity(polygon_shape))
        polygon_shape = polygon_shape.buffer(0)
        if not polygon_shape.is_valid:
            raise ValueError("WGS84 polygon geometry is invalid and could not be fixed.")

    centroid = polygon_shape.centroid
    lon, lat = centroid.x, centroid.y

    if lat > 84 or lat < -80:
        raise ValueError("UTM is undefined for latitudes beyond 84N/80S.")

    zone = int((lon + 180) // 6) + 1
    zone = max(1, min(zone, 60))

    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    print(f"Computed UTM EPSG:{epsg} from centroid lon/lat ({lon}, {lat}).")
    return epsg

def clipping_raster(polygon_geojson, image_path):
    # Validate polygon coordinates before clipping
    coords = polygon_geojson['coordinates']
    geometry_type = polygon_geojson['type']

    if geometry_type == 'Polygon':
        for ring in coords:
            for coord_pair in ring:
                if not all(np.isfinite(coord) for coord in coord_pair):
                    print("Invalid coordinate found:", coord_pair)
                    raise ValueError("Polygon coordinates are invalid. Please check the input polygon.")
    elif geometry_type == 'MultiPolygon':
        for polygon in coords:
            for ring in polygon:
                for coord_pair in ring:
                    if not all(np.isfinite(coord) for coord in coord_pair):
                        print("Invalid coordinate found:", coord_pair)
                        raise ValueError("Polygon coordinates are invalid. Please check the input polygon.")
    else:
        raise ValueError(f"Unsupported geometry type: {geometry_type}")

    with rasterio.open(image_path) as src:
        # Get raster bounds
        raster_bounds = src.bounds  # (left, bottom, right, top)
        raster_box = box(*raster_bounds)
        print("Raster Bounds:", raster_bounds)

        # Convert the transformed polygon to a Shapely geometry
        transformed_polygon_shape = shape(polygon_geojson)
        print("Transformed Polygon Bounds:", transformed_polygon_shape.bounds)

        # Check if they overlap
        if not transformed_polygon_shape.intersects(raster_box):
            raise ValueError("Transformed polygon does not overlap the raster.")

        # Proceed with clipping the raster
        try:
            cliped_image, cliped_transform = mask(
                src,
                [polygon_geojson],  # Ensure the geometry is inside a list
                crop=True
            )
        except ValueError as e:
            if 'Input shapes do not overlap raster' in str(e):
                raise ValueError("Transformed polygon does not overlap the raster.")
            else:
                raise

        out_meta = src.meta.copy()
        out_meta.update({
            "driver": "GTiff",
            "height": cliped_image.shape[1],
            "width": cliped_image.shape[2],
            "transform": cliped_transform,
            "crs": src.crs
        })
    return cliped_image, out_meta




def plotting_with_plotly(cliped_image):
    import numpy as np
    import plotly.express as px

    # Remove any singleton dimensions
    cliped_image = np.squeeze(cliped_image)

    # Handle NoData values
    nodata_value = 0 
    valid_mask = cliped_image != nodata_value

    if np.any(valid_mask):
        valid_data = cliped_image[valid_mask].astype('float32')

        # Normalize and scale data
        p2 = np.percentile(valid_data, 2)
        p98 = np.percentile(valid_data, 98)
        print("2nd Percentile:", p2)
        print("98th Percentile:", p98)

        clipped_data = np.clip(cliped_image, p2, p98)
        normalized_image = (clipped_data - p2) / (p98 - p2)
        normalized_image[~valid_mask] = np.nan

        # Create the Plotly figure
        fig = px.imshow(
            normalized_image,
            color_continuous_scale='viridis',
            origin='upper'
        )
        fig.update_layout(
            coloraxis_showscale=False,
            margin=dict(l=0, r=0, t=0, b=0),
            xaxis_visible=False,
            yaxis_visible=False
        )

        # Convert the figure to an HTML string
        html_str = fig.to_html(full_html=False)
        return html_str
    else:
        print("The clipped image contains no valid data.")
        return None



def mask_array(Fmask_clipped):
    bitword_order = (1, 1, 1, 1, 1, 1, 2)
    #define number of bitsword based on your input above
    num_bitwords = len(bitword_order)
    total_bits = sum(bitword_order)   # Should be 8, 16, or 32 depending on datatype
    #create a list of unique value that need to be converted into binary and decoded
    Unique_val_Fmask = list(np.unique(Fmask_clipped))
    goodQuality = []
    for j in Unique_val_Fmask:
        i= 0
        all_bits = []
        bits = total_bits
        binary = format(j, 'b').zfill(total_bits)
        all_bits.append(str(j) + '=' + str(binary)) 
        for b in bitword_order:
            Prev_bits = bits
            bits = bits - b
            i = i + 1
            if i == 1:
                bitword = binary[bits:]
                #print('Bit Word'  + str(i) + ':' + str(bitword))
                all_bits.append('Bit Word'  + str(i) + ':' + str(bitword))
            elif i == num_bitwords:
                bitword = binary[:Prev_bits]
                #print('Bit Word' + str(i) + ':' + str(bitword))
                all_bits.append('Bit Word'  + str(i) + ':' + str(bitword))
            else:
                bitword = binary [bits:Prev_bits]
                #print('Bit Word' + str(i) + ':' + str(bitword))
                all_bits.append('Bit Word'  + str(i) + ':' + str(bitword))
        
        if int(all_bits[2].split(':')[-1]) == 0 + int(all_bits[4].split(':')[-1]) == 0:
            goodQuality.append(j)
    return goodQuality


def image_reader(image_path):
    with rasterio.open(image_path) as src:
        img=src.read()

    return img
   
    

@csrf_protect
def EVI_timeseries(request):
    """
    Placeholder response: the previous implementation depended on local HLS folders and
    undefined helpers. Returning a clear message avoids server errors until data
    ingestion is wired up.
    """
    return JsonResponse(
        {'error': 'EVI time series is not configured for this deployment.'},
        status=501
    )

def plot_evi_timeseries(time_points, means, stds, width=10, height=6):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.ticker import AutoMinorLocator

    plt.style.use('seaborn-v0_8-whitegrid')
    fig, ax = plt.subplots(figsize=(width, height), dpi=100)
    
    # Main plot elements
    line = ax.plot(time_points, means, 
                 color='#2c3e50', 
                 linewidth=2, 
                 marker='o',
                 markersize=8,
                 markerfacecolor='#e74c3c',
                 markeredgecolor='white',
                 markeredgewidth=1,
                 label='EVI Mean')
    
    # Error band
    ax.fill_between(time_points, 
                  means - stds, 
                  means + stds,
                  color='#3498db', 
                  alpha=0.2,
                  label='±1 STD')
    
    # Formatting
    ax.set_xlabel('Time Sequence', fontsize=12, labelpad=10)
    ax.set_ylabel('Enhanced Vegetation Index (EVI)', fontsize=12, labelpad=10)
    ax.set_title('EVI Temporal Profile', fontsize=14, pad=15)
    
    # Grid and ticks
    ax.grid(True, which='major', linestyle='--', linewidth=0.8, alpha=0.7)
    ax.grid(True, which='minor', linestyle=':', linewidth=0.5, alpha=0.5)
    ax.xaxis.set_minor_locator(AutoMinorLocator())
    ax.yaxis.set_minor_locator(AutoMinorLocator())
    
    # Axis limits
    buffer = 0.1 * (np.nanmax(means + stds) - np.nanmin(means - stds))
    ax.set_ylim(np.nanmin(means - stds) - buffer, 
              np.nanmax(means + stds) + buffer)
    
    # Legend
    ax.legend(loc='best', frameon=True, fancybox=True, 
            facecolor='white', framealpha=0.8)
    
    # Final polish
    plt.tight_layout()
    
    # Save to buffer
    img_data = io.BytesIO()
    plt.savefig(img_data, format='png', bbox_inches='tight', dpi=150)
    img_data.seek(0)
    img_base64 = base64.b64encode(img_data.getvalue()).decode()
    plt.close()
    
    return f'<img src="data:image/png;base64,{img_base64}" style="width:100%; height:auto;">'



def band_stacker_from_mem(stacked_array, raster_profile, polygon_geojson, polygon_crs_epsg):
    """
    Clip the in-memory multiband array to the polygon, return features and metadata.
    """
    # Write to a MemoryFile so we can reuse rasterio.mask
    with MemoryFile() as memfile:
        with memfile.open(**raster_profile) as dataset:
            dataset.write(stacked_array)
            raster_crs = dataset.crs
            new_polygon_geojson = match_crs(raster_crs, polygon_geojson, polygon_crs_epsg)
            clipped_image, clipped_transform = mask(dataset, [new_polygon_geojson], crop=True)
            # Pixels outside the AOI are typically filled with 0 by rasterio.mask.
            # Keep a validity mask so we can force NoData after inference.
            valid_mask = np.any(clipped_image != 0, axis=0)
            print(f'Clipped Image Shape: {clipped_image.shape}')
            feature_input, height, width = prepare_features(clipped_image)
            src_profile = raster_profile.copy()
            return feature_input, height, width, src_profile, clipped_transform, valid_mask

def band_stacker(raster_path, polygon_geojson, polygon_crs_epsg):
    """
    Open a multiband raster on disk, clip to polygon, and prepare features.
    """
    with rasterio.open(raster_path) as src:
        src_profile = src.meta.copy()
        raster_crs = src.crs
        new_polygon_geojson = match_crs(raster_crs, polygon_geojson, polygon_crs_epsg)
        poly_bounds = shape(new_polygon_geojson).bounds
        print(f'Raster bounds: {src.bounds}')
        print(f'Polygon bounds: {poly_bounds}')

        clipped_image, clipped_transform = mask(src, [new_polygon_geojson], crop=True)
        # Pixels outside the AOI are typically filled with 0 by rasterio.mask.
        # Keep a validity mask so we can force NoData after inference.
        valid_mask = np.any(clipped_image != 0, axis=0)

        print(f'Clipped Image Shape: {clipped_image.shape}')
        feature_input, height, width = prepare_features(clipped_image)
        return feature_input, height, width, src_profile, clipped_transform, valid_mask
                
    

    


def predict_tiller_density(feature_input,height,width):
    # Reuse shared predictor that already handles scaling and reshaping to (batch, 4, 6)
    return predict_density(feature_input, height, width)





@csrf_protect
def TillerDensityMap(request):
    if request.method == 'POST':
        try:
            body = json.loads(request.body)
            polygon_geojson = body.get('polygon')
            crs_info = body.get('crs', 'EPSG:4326')
            date = body.get('date')

            if not polygon_geojson:
                return JsonResponse({'error': 'Polygon data is missing.'}, status=400)
            if not date:
                return JsonResponse({'error': 'Date is missing.'}, status=400)

            if crs_info.startswith('EPSG:'):
                polygon_crs_epsg = int(crs_info.split(':')[1])
            else:
                return JsonResponse({'error': 'Invalid CRS format.'}, status=400)
            
            # Reproject polygon to EPSG:4326 for the GEE download region
            polygon_geojson_wgs84 = match_crs(CRS.from_epsg(4326), polygon_geojson, polygon_crs_epsg)

            # Convert the input polygon to UTM for clipping (preserve input UTM when provided)
            if 32601 <= polygon_crs_epsg <= 32660 or 32701 <= polygon_crs_epsg <= 32760:
                utm_epsg = polygon_crs_epsg
                polygon_geojson_utm = match_crs(CRS.from_epsg(utm_epsg), polygon_geojson, polygon_crs_epsg)
            else:
                utm_epsg = utm_epsg_from_polygon(polygon_geojson_wgs84)
                polygon_geojson_utm = match_crs(CRS.from_epsg(utm_epsg), polygon_geojson_wgs84, 4326)

            # Use GEE to fetch image (saved to disk)
            try:
                print(f"Fetching GEE image for date: {date}")
                root_file = fetch_gee_image(polygon_geojson_wgs84, date, 4326)
                print(f"GEE Image saved to: {root_file}")
            except Exception as e:
                 return JsonResponse({'error': f"Failed to fetch satellite image: {str(e)}"}, status=500)

            # root_file = r"E:\Geodjango\PS\PS\planetscope_brookings.tif"

            # four_obs = filter_obs_day(root_folder, date)
            # if not four_obs:
            #     return JsonResponse({'error': 'No observations found for the given date.'}, status=400)
            
            # Clip using the UTM polygon
            feature_input,height,width, src_profile, clipped_transform, valid_mask = band_stacker(
                root_file, polygon_geojson_utm, utm_epsg
            )
            print('Band Stacking done')

            density_array = predict_tiller_density(feature_input,height,width)
            # Force outside-AOI pixels to NoData so frontend renders them transparent.
            density_array = density_array.astype(np.float32, copy=False)
            nodata_value = -99999.0
            density_array[~valid_mask] = nodata_value
            print('Tiller Density prediction done')

            timestamp = datetime.now().strftime("%Y%m%d%H%M%S") #timestamp for unique file name
            output_filename = f'tiller_density_map_{timestamp}.tif'
            output_path = os.path.join(settings.MEDIA_ROOT, output_filename)
            os.makedirs(settings.MEDIA_ROOT, exist_ok=True)
            create_outputRaster_COG(src_profile, clipped_transform, density_array, output_path, target_crs="EPSG:3857")

            # Get raster metadata for client-side positioning
            with rasterio.open(output_path) as src:
                bounds = src.bounds
                crs = src.crs.to_string()
            # Construct accessible URL
            cog_url = request.build_absolute_uri(
                reverse('media_range', kwargs={'filename': output_filename})
            )
            print(f'cog_url: {cog_url}')
            # # Call your leafmap helper function to generate the map HTML.
            # map_html = generate_damage_map_html()

            # return HttpResponse(map_html, content_type="text/html")
            return JsonResponse({
                'status': 'success',
                'cog_url': cog_url,
                'bounds': {
                    'left': bounds.left,
                    'bottom': bounds.bottom,
                    'right': bounds.right,
                    'top': bounds.top
                },
                'crs': crs
            })
        except Exception as e:
            return JsonResponse({
                'status': 'error',
                'error': str(e)
            }, status=500)
        
    else:    
        return JsonResponse({'error': 'Method not allowed. Use POST.'}, status=405)







def create_outputRaster_COG(raster_profile, transform, predictArray, output_path, target_crs="EPSG:3857"):
    """Reproject prediction array to a Cloud Optimized GeoTIFF."""
    from rasterio.warp import calculate_default_transform, reproject, Resampling
    import numpy as np

    try:
        print(f"Target CRS: {target_crs}")
        print(f"Source CRS: {raster_profile['crs']}")
        print(f"Clipped Transform: {transform}")
        print(f"Array Shape: {predictArray.shape}")

        left, top = transform * (0, 0)
        right, bottom = transform * (predictArray.shape[1], predictArray.shape[0])
        print(f"Computed Clipped Bounds: Left={left}, Right={right}, Top={top}, Bottom={bottom}")

        dst_transform, dst_width, dst_height = calculate_default_transform(
            raster_profile['crs'],
            target_crs,
            predictArray.shape[1],
            predictArray.shape[0],
            left=left,
            bottom=bottom,
            right=right,
            top=top,
        )

        print(f"New Transform: {dst_transform}")
        print(f"New Size: Width={dst_width}, Height={dst_height}")

        nodata_value = -99999.0
        profile = raster_profile.copy()
        profile.update(
            {
                "driver": "COG",
                "crs": target_crs,
                "transform": dst_transform,
                "width": dst_width,
                "height": dst_height,
                "count": 1,
                "dtype": "float32",
                "compress": "LZW",
                "nodata": nodata_value,
            }
        )

        for key in ["TILED", "BLOCKXSIZE", "BLOCKYSIZE", "INTERLEAVE"]:
            profile.pop(key.lower(), None)

        destination = np.full((dst_height, dst_width), nodata_value, dtype=np.float32)

        with rasterio.open(output_path, "w", **profile) as dst:
            reproject(
                source=predictArray,
                destination=destination,
                src_transform=transform,
                src_crs=raster_profile["crs"],
                dst_transform=dst_transform,
                dst_crs=target_crs,
                src_nodata=nodata_value,
                dst_nodata=nodata_value,
                init_dest_nodata=True,
                resampling=Resampling.nearest,
            )
            dst.write(destination, 1)

        print(f"Successfully saved COG to: {output_path}")
        return output_path

    except Exception as e:
        print(f"Reprojection failed: {str(e)}")
        raise e

def serve_media_range(request, filename):
    def stream_file_range(path, start, length, chunk_size=1024 * 128):
        with open(path, 'rb') as file_obj:
            file_obj.seek(start)
            remaining = length
            while remaining > 0:
                chunk = file_obj.read(min(chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    # Prevent path traversal and build absolute path
    safe_path = os.path.normpath(os.path.join(settings.MEDIA_ROOT, filename))
    if not safe_path.startswith(os.path.abspath(settings.MEDIA_ROOT)):
        return JsonResponse({"error": "Invalid file path."}, status=400)
    file_path = safe_path

    if not os.path.exists(file_path):
        return JsonResponse({"error": "File not found."}, status=404)

    file_size = os.path.getsize(file_path)
    content_type = 'image/tiff'  # adjust if needed

    first_byte = 0
    last_byte = file_size - 1
    status_code = 200
    range_header = request.META.get('HTTP_RANGE', '').strip()
    if range_header:
        # Example of a Range header: "bytes=0-65535"
        range_match = re.match(r'bytes=(\d+)-(\d*)$', range_header)
        if not range_match:
            return JsonResponse({"error": "Malformed Range header."}, status=400)
        first_byte, last_byte_str = range_match.groups()
        first_byte = int(first_byte)
        last_byte = int(last_byte_str) if last_byte_str else file_size - 1
        if first_byte >= file_size or first_byte > last_byte:
            response = JsonResponse({"error": "Requested range not satisfiable."}, status=416)
            response['Content-Range'] = f'bytes */{file_size}'
            response['Accept-Ranges'] = 'bytes'
            return response
        last_byte = min(last_byte, file_size - 1)
        status_code = 206

    length = last_byte - first_byte + 1
    response = StreamingHttpResponse(
        stream_file_range(file_path, first_byte, length),
        status=status_code,
        content_type=content_type
    )
    response['Content-Length'] = str(length)
    if status_code == 206:
        response['Content-Range'] = f'bytes {first_byte}-{last_byte}/{file_size}'

    response['Accept-Ranges'] = 'bytes'
    response['Access-Control-Allow-Origin'] = '*'
    return response


def generate_report(request):
    if request.method == "POST":
        # If you don't need any logic, just return a minimal JSON
        return JsonResponse({"stats": {"min": 0, "max": 0, "avg": 0}})
    else:
        return JsonResponse({"error": "Method not allowed"}, status=405)













