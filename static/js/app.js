(function() {
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrftoken = csrfMeta ? csrfMeta.getAttribute('content') : '';
  const NODATA = -99999;
  const MIN_OVERLAY_LONG_SIDE_PX = 900;
  const MAX_OVERLAY_UPSCALE = 32;
  const renderedPanelMaps = new Map();
  const PANEL_MAP_RASTER_RESOLUTION = 32;

  function reportBootstrapError(message) {
    console.error(message);
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.innerHTML = `
        <div class="map-error">
          <h4>Map Initialization Error</h4>
          <p>${message}</p>
        </div>`;
    }
  }

  if (typeof window.L === 'undefined') {
    reportBootstrapError('Leaflet failed to load. Check network access to CDN assets and retry.');
    return;
  }

  const mapRoot = document.getElementById('map');
  if (!mapRoot) {
    reportBootstrapError('Missing map container (#map).');
    return;
  }

  const map = L.map(mapRoot, { center: [44.5, -96.8], zoom: 10 });
  window.map = map;

  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Basemap: © Esri'
  }).addTo(map);
  const drawnItems = new L.FeatureGroup().addTo(map);
  const baseLayers = {
    'Satellite Basemap': sat,
    'Street Basemap': street
  };
  const overlays = {
    'Drawn AOI': drawnItems
  };
  const layerControl = L.control.layers(baseLayers, overlays, {
    position: 'bottomleft',
    collapsed: false
  }).addTo(map);

  const layerControlContainer = layerControl.getContainer();
  if (layerControlContainer) {
    layerControlContainer.classList.add('base-layer-control');
    const title = document.createElement('div');
    title.className = 'layer-control-title';
    title.textContent = 'Layers';
    layerControlContainer.prepend(title);
  }

  const drawControl = new L.Control.Draw({
    edit: { featureGroup: drawnItems },
    draw: { polygon: true, rectangle: true }
  });
  map.addControl(drawControl);

  map.on('draw:created', (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    window.drawnGeoJSON = e.layer.toGeoJSON();
    window.crs = 'EPSG:4326';
    window.tillerCogUrl = null;
    window.classifiedCogUrl = null;
    window.classBreaks = null;
    clearMainTillerOverlay();
    setSelectedActionButton(null);
    maybeEnableButtons();
  });

  const dateInput = document.getElementById('date-input');
  const tillerBtn = document.getElementById('tiller-density-button');
  const reportBtn = document.getElementById('report-button');
  const reportDownloadBtn = document.getElementById('report-download-button');
  const nutrientBtn = document.getElementById('nutrient-prescription-button');
  const userGuideBtn = document.getElementById('user-guide-button');
  const guideModal = document.getElementById('guide-modal');
  const guideModalCloseBtn = document.getElementById('guide-modal-close');
  const aboutUsBtn = document.getElementById('about-us-button');
  const aboutModal = document.getElementById('about-modal');
  const aboutModalCloseBtn = document.getElementById('about-modal-close');
  const mapStage = document.querySelector('.map-stage');
  const minimizedDock = document.getElementById('minimized-dock');
  if (!dateInput || !tillerBtn || !reportBtn || !mapStage) {
    reportBootstrapError('Required UI controls were not found. Ensure the page template includes all map controls.');
    return;
  }
  const panelIds = ['tiller-density-map', 'report-container'];
  const actionButtons = [tillerBtn, reportBtn].filter(Boolean);
  let mainTillerLayer = null;
  let mainTillerLegend = null;
  let mainTillerScale = null;
  let toastHideTimer = null;
  let panelZCounter = 1260;
  if (nutrientBtn) {
    nutrientBtn.disabled = true; // not implemented
  }

  function setSelectedActionButton(activeBtn) {
    actionButtons.forEach((btn) => {
      btn.classList.toggle('is-selected', btn === activeBtn);
    });
  }

  function registerPanelMap(containerId, mapInstance) {
    const existing = renderedPanelMaps.get(containerId);
    if (existing && existing !== mapInstance) {
      try {
        existing.remove();
      } catch (err) {
        console.warn('Failed to remove previous map instance:', err);
      }
    }
    renderedPanelMaps.set(containerId, mapInstance);
  }

  function destroyPanelMap(containerId) {
    const existing = renderedPanelMaps.get(containerId);
    if (!existing) return;
    try {
      existing.remove();
    } catch (err) {
      console.warn('Failed to destroy panel map instance:', err);
    }
    renderedPanelMaps.delete(containerId);
  }

  function panelTitle(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return panelId;
    const title = panel.querySelector('.panel-header h3');
    return title ? title.textContent.trim() : panelId;
  }

  function bringPanelToFront(panel) {
    if (!panel) return;
    panelZCounter += 1;
    panel.style.zIndex = String(panelZCounter);
  }

  function refreshPanelMaps(panel) {
    if (!panel) return;
    panel.querySelectorAll('[id]').forEach((el) => {
      const m = renderedPanelMaps.get(el.id);
      if (m) {
        try {
          m.invalidateSize();
        } catch (err) {
          console.warn('Failed to refresh map instance:', err);
        }
      }
    });
  }

  function clampPanelToStage(panel) {
    if (!panel || !mapStage) return;
    const stageRect = mapStage.getBoundingClientRect();
    const leftMax = Math.max(12, stageRect.width - panel.offsetWidth - 12);
    const topMax = Math.max(88, stageRect.height - panel.offsetHeight - 12);

    let left = parseFloat(panel.style.left);
    let top = parseFloat(panel.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      const rect = panel.getBoundingClientRect();
      left = rect.left - stageRect.left;
      top = rect.top - stageRect.top;
    }

    left = Math.max(12, Math.min(left, leftMax));
    top = Math.max(88, Math.min(top, topMax));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  }

  function autoPlacePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel || !mapStage) return;
    const visible = panelIds
      .filter((id) => id !== panelId)
      .map((id) => document.getElementById(id))
      .filter((p) => p && p.style.display !== 'none');

    if (!visible.length) {
      panel.style.right = '20px';
      panel.style.left = 'auto';
      panel.style.top = '88px';
      return;
    }

    const anchor = visible[visible.length - 1];
    const stageRect = mapStage.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const anchorLeft = anchorRect.left - stageRect.left;
    const anchorRight = anchorRect.right - stageRect.left;
    const gap = 14;

    // Prefer placing next to the visible panel without overlap.
    let left = anchorLeft - panelWidth - gap;
    if (left < 12) {
      left = anchorRight + gap;
    }
    if (left + panelWidth > stageRect.width - 12) {
      left = stageRect.width - panelWidth - 12;
    }
    if (left < 12) {
      left = 12;
    }

    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(88, (anchorRect.top - stageRect.top) + 12)}px`;
    panel.style.right = 'auto';
    clampPanelToStage(panel);
  }

  function addDockButton(panelId) {
    if (!minimizedDock) return;
    let btn = minimizedDock.querySelector(`.dock-pill[data-panel="${panelId}"]`);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dock-pill';
      btn.dataset.panel = panelId;
      btn.addEventListener('click', () => openPanel(panelId));
      minimizedDock.appendChild(btn);
    }
    btn.textContent = panelTitle(panelId);
    btn.title = panelTitle(panelId);
  }

  function removeDockButton(panelId) {
    if (!minimizedDock) return;
    const btn = minimizedDock.querySelector(`.dock-pill[data-panel="${panelId}"]`);
    if (btn) btn.remove();
  }

  function minimizePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.style.display = 'none';
    addDockButton(panelId);
  }

  function initPanelDrag(panel) {
    if (!panel) return;
    const header = panel.querySelector('.panel-header');
    if (!header) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (panel.style.display === 'none') return;
      dragging = true;
      header.setPointerCapture(e.pointerId);
      bringPanelToFront(panel);

      const stageRect = mapStage.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left - stageRect.left;
      startTop = rect.top - stageRect.top;
      panel.style.right = 'auto';
      panel.classList.add('is-dragging');
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${startLeft + dx}px`;
      panel.style.top = `${startTop + dy}px`;
      clampPanelToStage(panel);
    });

    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      panel.dataset.userPositioned = '1';
      try {
        header.releasePointerCapture(e.pointerId);
      } catch {
        // no-op
      }
    };
    header.addEventListener('pointerup', stopDrag);
    header.addEventListener('pointercancel', stopDrag);
  }

  function openPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    removeDockButton(panelId);
    panel.style.display = 'block';
    bringPanelToFront(panel);
    if (panel.dataset.userPositioned === '1') {
      clampPanelToStage(panel);
    } else {
      autoPlacePanel(panelId);
    }
    setTimeout(() => {
      map.invalidateSize();
      refreshPanelMaps(panel);
    }, 0);
  }

  function hidePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    removeDockButton(panelId);
    panel.style.display = 'none';
  }

  document.querySelectorAll('.panel-close').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panelId = btn.getAttribute('data-panel');
      hidePanel(panelId);
    });
  });

  document.querySelectorAll('.panel-minimize').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panelId = btn.getAttribute('data-panel');
      minimizePanel(panelId);
    });
  });

  panelIds.forEach((id) => initPanelDrag(document.getElementById(id)));
  panelIds.forEach((id) => {
    const panel = document.getElementById(id);
    if (panel) {
      panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
    }
  });
  window.addEventListener('resize', () => {
    panelIds.forEach((id) => {
      const panel = document.getElementById(id);
      if (panel && panel.style.display !== 'none') {
        clampPanelToStage(panel);
      }
    });
  });

  dateInput.addEventListener('change', maybeEnableButtons);

  function maybeEnableButtons() {
    const hasDate = !!dateInput.value;
    const hasGeom = !!window.drawnGeoJSON;
    const enable = hasDate && hasGeom;
    tillerBtn.disabled = !enable;
    reportBtn.disabled = !enable;
  }

  function showToast(msg, isError = false, durationMs = 3000) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    toast.style.background = isError ? '#e74c3c' : '#2c3e50';
    toast.textContent = msg;
    toast.style.display = 'block';
    if (durationMs > 0) {
      toastHideTimer = setTimeout(() => {
        toast.style.display = 'none';
        toastHideTimer = null;
      }, durationMs);
    }
  }

  function setLoading(panelId, isLoading) {
    openPanel(panelId);
    const contentId = panelId + '-content';
    const content = document.getElementById(contentId);
    if (isLoading) {
      content.innerHTML = '<div class="map-loading"><div class="spinner"></div><p>Processing...</p></div>';
    }
  }

  function openModal(modalEl, closeBtnEl) {
    if (!modalEl) return;
    modalEl.classList.add('is-open');
    modalEl.setAttribute('aria-hidden', 'false');
    if (closeBtnEl) closeBtnEl.focus();
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.remove('is-open');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  function setupModal(triggerBtn, modalEl, closeBtnEl) {
    if (!triggerBtn || !modalEl) return;
    triggerBtn.addEventListener('click', () => openModal(modalEl, closeBtnEl));
    if (closeBtnEl) {
      closeBtnEl.addEventListener('click', () => closeModal(modalEl));
    }
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeModal(modalEl);
    });
  }

  setupModal(aboutUsBtn, aboutModal, aboutModalCloseBtn);
  setupModal(userGuideBtn, guideModal, guideModalCloseBtn);

  async function fitMapForPdfBestView(mapInstance) {
    if (!mapInstance) return;

    mapInstance.invalidateSize();

    let combinedBounds = null;
    mapInstance.eachLayer((layer) => {
      if (!layer || typeof layer.getBounds !== 'function') return;
      if (typeof L !== 'undefined' && layer instanceof L.TileLayer) return;
      const b = layer.getBounds();
      if (!b || typeof b.isValid !== 'function' || !b.isValid()) return;
      if (!combinedBounds) {
        combinedBounds = L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      } else {
        combinedBounds.extend(b);
      }
    });

    if (combinedBounds && combinedBounds.isValid()) {
      mapInstance.fitBounds(combinedBounds, { animate: false, padding: [18, 18] });
      await waitForMoveEndOrTimeout(mapInstance, 140);
    }
    mapInstance.invalidateSize();
  }

  async function downloadReportPdf() {
    const reportPanel = document.getElementById('report-container');
    const reportContent = document.getElementById('report-content');
    if (!reportPanel || reportPanel.style.display === 'none') {
      showToast('Open the report before downloading PDF.', true);
      return;
    }
    if (!reportContent || !reportContent.classList.contains('report-layout')) {
      showToast('Generate report content before downloading PDF.', true);
      return;
    }
    if (typeof window.html2canvas !== 'function' || !window.jspdf || !window.jspdf.jsPDF) {
      showToast('PDF export library is unavailable.', true);
      return;
    }

    const originalLabel = reportDownloadBtn ? reportDownloadBtn.textContent : '';
    try {
      if (reportDownloadBtn) {
        reportDownloadBtn.disabled = true;
        reportDownloadBtn.textContent = '...';
      }

      const densityMap = renderedPanelMaps.get('density-map');
      const classifiedMap = renderedPanelMaps.get('classified-map');
      await fitMapForPdfBestView(densityMap);
      await fitMapForPdfBestView(classifiedMap);

      const canvas = await window.html2canvas(reportPanel, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#274563',
      });
      const imgData = canvas.toDataURL('image/png');

      const { jsPDF } = window.jspdf;
      const margin = 6;
      const a4Portrait = { width: 210, height: 297 };
      const a4Landscape = { width: 297, height: 210 };
      const imageAspect = canvas.width / Math.max(1, canvas.height);
      const fitWithinPage = (page) => {
        const maxWidth = page.width - margin * 2;
        const maxHeight = page.height - margin * 2;
        let drawWidth = maxWidth;
        let drawHeight = drawWidth / imageAspect;
        if (drawHeight > maxHeight) {
          drawHeight = maxHeight;
          drawWidth = drawHeight * imageAspect;
        }
        return { drawWidth, drawHeight };
      };

      const portraitFit = fitWithinPage(a4Portrait);
      const landscapeFit = fitWithinPage(a4Landscape);
      const useLandscape = (landscapeFit.drawWidth * landscapeFit.drawHeight) > (portraitFit.drawWidth * portraitFit.drawHeight);

      const pdf = new jsPDF(useLandscape ? 'l' : 'p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const bestFit = useLandscape ? landscapeFit : portraitFit;
      const x = (pageWidth - bestFit.drawWidth) / 2;
      const y = (pageHeight - bestFit.drawHeight) / 2;

      // Single-page export: scale and center the full report image inside A4 bounds.
      pdf.addImage(imgData, 'PNG', x, y, bestFit.drawWidth, bestFit.drawHeight, undefined, 'FAST');

      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      pdf.save(`wheat-tdm-report-${ts}.pdf`);
      showToast('Report PDF downloaded');
    } catch (err) {
      console.error(err);
      showToast(`Failed to download PDF: ${err.message || err}`, true);
    } finally {
      if (reportDownloadBtn) {
        reportDownloadBtn.disabled = false;
        reportDownloadBtn.textContent = originalLabel || 'PDF';
      }
    }
  }

  if (reportDownloadBtn) {
    reportDownloadBtn.addEventListener('click', downloadReportPdf);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    [aboutModal, guideModal].forEach((modalEl) => {
      if (modalEl && modalEl.classList.contains('is-open')) {
        closeModal(modalEl);
      }
    });
  });

  async function postJson(url, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (csrftoken) {
      headers['X-CSRFToken'] = csrftoken;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text || resp.statusText);
    }
    return resp.json();
  }

  function quantile(sortedValues, q) {
    if (!sortedValues.length) return 0;
    if (q <= 0) return sortedValues[0];
    if (q >= 1) return sortedValues[sortedValues.length - 1];
    const pos = (sortedValues.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    const left = sortedValues[base];
    const right = sortedValues[Math.min(base + 1, sortedValues.length - 1)];
    return left + rest * (right - left);
  }

  function toScalarPixelValue(val) {
    if (Array.isArray(val) || ArrayBuffer.isView(val)) {
      return Number(val[0]);
    }
    if (val && typeof val === 'object') {
      if ('value' in val) return Number(val.value);
      const keys = Object.keys(val);
      if (keys.length) return Number(val[keys[0]]);
    }
    return Number(val);
  }

  function flattenBandValues(bandValues) {
    const flattened = [];
    for (const row of bandValues) {
      if (Array.isArray(row) || ArrayBuffer.isView(row)) {
        for (const v of row) flattened.push(Number(v));
      } else {
        flattened.push(Number(row));
      }
    }
    return flattened;
  }

  function inferEpsgCode(georaster) {
    if (!georaster) return null;
    const projection = georaster.projection;
    if (Number.isFinite(Number(projection))) return Number(projection);
    const hints = [
      projection,
      georaster.proj4,
      georaster.projcode,
      georaster.srs
    ]
      .map((v) => (v == null ? '' : String(v)))
      .join(' ')
      .toUpperCase();
    const match = hints.match(/EPSG[:/ ]?(\d{4,5})/);
    return match ? Number(match[1]) : null;
  }

  function georasterBoundsToLatLngBounds(georaster) {
    if (!georaster) return null;
    const xmin = Number(georaster.xmin);
    const xmax = Number(georaster.xmax);
    const ymin = Number(georaster.ymin);
    const ymax = Number(georaster.ymax);
    if (![xmin, xmax, ymin, ymax].every(Number.isFinite)) return null;

    const epsg = inferEpsgCode(georaster);
    const looksLikeLatLng =
      Math.abs(xmin) <= 180 &&
      Math.abs(xmax) <= 180 &&
      Math.abs(ymin) <= 90 &&
      Math.abs(ymax) <= 90;
    if (epsg === 4326 || looksLikeLatLng) {
      return L.latLngBounds([ymin, xmin], [ymax, xmax]);
    }

    const sw = L.CRS.EPSG3857.unproject(L.point(xmin, ymin));
    const ne = L.CRS.EPSG3857.unproject(L.point(xmax, ymax));
    return L.latLngBounds(sw, ne);
  }

  function buildRasterOverlayDataUrl(georaster, colorForValue) {
    const bandRows = georaster && georaster.values ? georaster.values[0] : null;
    if (!bandRows || !bandRows.length) {
      throw new Error('Raster grid is unavailable for overlay rendering.');
    }

    const height = Number(georaster.height) || bandRows.length;
    const firstRow = bandRows[0];
    const inferredWidth = (Array.isArray(firstRow) || ArrayBuffer.isView(firstRow)) ? firstRow.length : 0;
    const width = Number(georaster.width) || inferredWidth;
    if (!width || !height) {
      throw new Error('Raster dimensions are invalid.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create raster overlay canvas.');

    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;
    let offset = 0;
    for (let y = 0; y < height; y += 1) {
      const row = bandRows[y];
      for (let x = 0; x < width; x += 1) {
        const rawValue = (Array.isArray(row) || ArrayBuffer.isView(row)) ? row[x] : row;
        const scalar = Number(rawValue);
        const color = colorForValue(scalar, x, y);
        if (color) {
          pixels[offset] = color[0];
          pixels[offset + 1] = color[1];
          pixels[offset + 2] = color[2];
          pixels[offset + 3] = color[3] == null ? 255 : color[3];
        } else {
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
          pixels[offset + 3] = 0;
        }
        offset += 4;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Upscale tiny rasters with nearest-neighbor to avoid browser blur.
    const longestSide = Math.max(width, height);
    let upscaleFactor = Math.ceil(MIN_OVERLAY_LONG_SIDE_PX / Math.max(1, longestSide));
    upscaleFactor = Math.max(1, Math.min(MAX_OVERLAY_UPSCALE, upscaleFactor));
    if (upscaleFactor === 1) {
      return canvas.toDataURL('image/png');
    }

    const upscaled = document.createElement('canvas');
    upscaled.width = width * upscaleFactor;
    upscaled.height = height * upscaleFactor;
    const upCtx = upscaled.getContext('2d');
    if (!upCtx) return canvas.toDataURL('image/png');
    upCtx.imageSmoothingEnabled = false;
    upCtx.drawImage(canvas, 0, 0, upscaled.width, upscaled.height);

    return upscaled.toDataURL('image/png');
  }

  function buildCdfMap(values) {
    const freq = new Map();
    values.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
    const unique = Array.from(freq.keys()).sort((a, b) => a - b);
    const cdf = new Map();
    let cumulative = 0;
    const total = values.length || 1;
    unique.forEach(v => {
      cumulative += freq.get(v);
      cdf.set(v, cumulative / total);
    });
    return cdf;
  }

  function formatNumber(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'NA';
    return n.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function computeStats(values) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;

    for (let i = 0; i < values.length; i += 1) {
      const v = Number(values[i]);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count += 1;
    }

    if (!count) {
      return { min: 0, max: 0, avg: 0, count: 0 };
    }

    return { min, max, avg: sum / count, count };
  }

  function clearMainTillerOverlay() {
    if (mainTillerLayer) {
      try {
        map.removeLayer(mainTillerLayer);
      } catch (err) {
        console.warn('Failed to remove existing tiller layer from map:', err);
      }
      try {
        layerControl.removeLayer(mainTillerLayer);
      } catch (err) {
        console.warn('Failed to remove existing tiller layer from layer control:', err);
      }
      mainTillerLayer = null;
    }

    if (mainTillerLegend) {
      try {
        map.removeControl(mainTillerLegend);
      } catch (err) {
        console.warn('Failed to remove tiller legend from map:', err);
      }
      mainTillerLegend = null;
    }

    if (mainTillerScale) {
      try {
        map.removeControl(mainTillerScale);
      } catch (err) {
        console.warn('Failed to remove tiller scale from map:', err);
      }
      mainTillerScale = null;
    }
  }

  function alignTillerLegendBetweenControls(mapInstance, legendControl, layerControlInstance, scaleControlInstance) {
    if (!mapInstance || !legendControl) return;
    const mapEl = mapInstance.getContainer ? mapInstance.getContainer() : null;
    const legendEl = legendControl.getContainer ? legendControl.getContainer() : null;
    const layersEl = layerControlInstance && layerControlInstance.getContainer ? layerControlInstance.getContainer() : null;
    const scaleEl = scaleControlInstance && scaleControlInstance.getContainer ? scaleControlInstance.getContainer() : null;
    if (!legendEl || !mapEl) return;

    // Take legend out of Leaflet's stacked corner flow and place it explicitly.
    if (legendEl.parentElement !== mapEl) {
      mapEl.appendChild(legendEl);
    }

    const apply = () => {
      const controlInset = 12;
      const controlGap = 22;
      const mapWidth = mapInstance.getSize ? mapInstance.getSize().x : 0;
      const layersWidth = layersEl ? layersEl.offsetWidth : 0;
      const scaleWidth = scaleEl ? scaleEl.offsetWidth : 0;
      const leftOffset = Math.max(controlInset, layersWidth + controlInset + controlGap);
      const rightReserve = Math.max(controlInset + 4, scaleWidth + controlInset + 8);
      const available = mapWidth - leftOffset - rightReserve;
      const width = Math.min(250, Math.max(160, available));

      if (layersEl) {
        layersEl.style.marginLeft = `${controlInset}px`;
        layersEl.style.marginBottom = `${controlInset}px`;
      }

      legendEl.style.position = 'absolute';
      legendEl.style.left = `${leftOffset}px`;
      legendEl.style.bottom = `${controlInset}px`;
      legendEl.style.margin = '0';
      legendEl.style.zIndex = '650';
      legendEl.style.width = `${width}px`;
    };

    apply();
    setTimeout(apply, 0);
    mapInstance.on('resize', apply);
  }

  function ensureLayerPainted(mapInstance, layerInstance) {
    return new Promise((resolve) => {
      const repaint = () => {
        try {
          mapInstance.invalidateSize();
        } catch (err) {
          console.warn('Failed to invalidate map size:', err);
        }
        if (layerInstance && typeof layerInstance.redraw === 'function') {
          try {
            layerInstance.redraw();
          } catch (err) {
            console.warn('Failed to redraw raster layer:', err);
          }
        }
      };

      repaint();
      requestAnimationFrame(() => {
        repaint();
        setTimeout(() => {
          repaint();
          resolve();
        }, 60);
      });
    });
  }

  function waitForMoveEndOrTimeout(mapInstance, timeoutMs = 180) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      mapInstance.once('moveend', finish);
      setTimeout(finish, timeoutMs);
    });
  }

  async function renderRasterOnMainMap(cogUrl, legendLabel) {
    const georaster = await fetch(cogUrl).then(r => r.arrayBuffer()).then(parseGeoraster);
    const bandData = flattenBandValues(georaster.values[0]);
    const valid = bandData.filter(v => Number.isFinite(v) && v !== NODATA);
    if (!valid.length) {
      throw new Error('No valid raster values available for visualization.');
    }

    const sorted = valid.slice().sort((a, b) => a - b);
    const bandMin = sorted[0];
    const bandMax = sorted[sorted.length - 1];
    const clipPct = 0.005;
    const pLow = quantile(sorted, clipPct);
    const pHigh = quantile(sorted, 1 - clipPct);
    const stretchMin = pLow;
    const stretchMax = pHigh > pLow ? pHigh : bandMax > bandMin ? bandMax : bandMin + 1e-6;
    const palette = ['#ffffe5', '#f7fcb9', '#d9f0a3', '#addd8e', '#78c679', '#41ab5d', '#238443', '#006837', '#004529'];
    const scale = chroma.scale(palette).domain([0, 1]);

    clearMainTillerOverlay();

    const bounds = georasterBoundsToLatLngBounds(georaster);
    if (!bounds || !bounds.isValid()) {
      throw new Error('Could not determine raster bounds for map overlay.');
    }
    const overlayImageUrl = buildRasterOverlayDataUrl(georaster, (scalar) => {
      if (!Number.isFinite(scalar) || scalar === NODATA) return null;
      const denom = Math.max(1e-9, stretchMax - stretchMin);
      const z = Math.max(0, Math.min(1, (scalar - stretchMin) / denom));
      const rgba = scale(z).rgba();
      return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), 255];
    });
    const layer = L.imageOverlay(overlayImageUrl, bounds, { opacity: 1.0, interactive: false });

    layer.addTo(map);
    layerControl.addOverlay(layer, 'Tiller Density Overlay');
    mainTillerLayer = layer;

    map.fitBounds(bounds, { padding: [18, 18], animate: false });
    await waitForMoveEndOrTimeout(map, 200);
    await ensureLayerPainted(map, null);

    const mapScale = L.control.scale({ position: 'bottomleft', metric: true, imperial: false });
    mapScale.addTo(map);
    mainTillerScale = mapScale;

    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'info legend');
      const leftLabel = formatNumber(pLow, 2);
      const rightLabel = formatNumber(pHigh, 2);
      div.classList.add('tiller-legend');
      div.innerHTML = `
        <div class="tiller-legend-title">${legendLabel}</div>
        <div class="tiller-legend-scale">
          <span class="tiller-legend-label">${leftLabel}</span>
          <div class="tiller-legend-ramp" style="background:linear-gradient(to right, ${palette.join(', ')});"></div>
          <span class="tiller-legend-label">${rightLabel}</span>
        </div>`;
      return div;
    };
    legend.addTo(map);
    mainTillerLegend = legend;
  }

  async function renderRasterOnMap(cogUrl, containerId, legendLabel) {
    const georaster = await fetch(cogUrl).then(r => r.arrayBuffer()).then(parseGeoraster);
    const bandData = flattenBandValues(georaster.values[0]);
    const valid = bandData.filter(v => Number.isFinite(v) && v !== NODATA);
    if (!valid.length) {
      throw new Error('No valid raster values available for visualization.');
    }
    const sorted = valid.slice().sort((a, b) => a - b);
    const bandMin = sorted[0];
    const bandMax = sorted[sorted.length - 1];

    const clipPct = 0.005; // ArcGIS-style percent clip: 0.5% tails
    const pLow = quantile(sorted, clipPct);
    const pHigh = quantile(sorted, 1 - clipPct);
    const stretchMin = pLow;
    const stretchMax = pHigh > pLow ? pHigh : bandMax > bandMin ? bandMax : bandMin + 1e-6;

    // ArcGIS-like green sequential stretch (light to dark green).
    const palette = ['#ffffe5', '#f7fcb9', '#d9f0a3', '#addd8e', '#78c679', '#41ab5d', '#238443', '#006837', '#004529'];
    const scale = chroma.scale(palette).domain([0, 1]);

    const bounds = georasterBoundsToLatLngBounds(georaster);
    if (!bounds || !bounds.isValid()) {
      throw new Error('Could not determine raster bounds for map overlay.');
    }
    const overlayImageUrl = buildRasterOverlayDataUrl(georaster, (scalar) => {
      if (!Number.isFinite(scalar) || scalar === NODATA) return null;
      const denom = Math.max(1e-9, stretchMax - stretchMin);
      const z = Math.max(0, Math.min(1, (scalar - stretchMin) / denom));
      const rgba = scale(z).rgba();
      return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), 255];
    });
    const layer = L.imageOverlay(overlayImageUrl, bounds, { opacity: 1.0, interactive: false });

    const mapInstance = L.map(containerId).setView([44.5, -96.8], 10);
    registerPanelMap(containerId, mapInstance);
    const popupStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    });
    const popupSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Basemap: © Esri'
    }).addTo(mapInstance);
    layer.addTo(mapInstance);
    const popupLayerControl = L.control.layers(
      {
        'Satellite Basemap': popupSatellite,
        'Street Basemap': popupStreet
      },
      {
        'Tiller Density Overlay': layer
      },
      {
        position: 'bottomleft',
        collapsed: false
      }
    ).addTo(mapInstance);
    const popupLayerControlContainer = popupLayerControl.getContainer();
    if (popupLayerControlContainer) {
      popupLayerControlContainer.classList.add('base-layer-control');
      const title = document.createElement('div');
      title.className = 'layer-control-title';
      title.textContent = 'Layers';
      popupLayerControlContainer.prepend(title);
    }

    mapInstance.fitBounds(bounds, { animate: false });
    await waitForMoveEndOrTimeout(mapInstance, 200);

    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'info legend');
      const leftLabel = formatNumber(pLow, 2);
      const rightLabel = formatNumber(pHigh, 2);
      div.classList.add('tiller-legend');
      div.innerHTML = `
        <div class="tiller-legend-title">${legendLabel}</div>
        <div class="tiller-legend-scale">
          <span class="tiller-legend-label">${leftLabel}</span>
          <div class="tiller-legend-ramp" style="background:linear-gradient(to right, ${palette.join(', ')});"></div>
          <span class="tiller-legend-label">${rightLabel}</span>
        </div>`;
      return div;
    };
    legend.addTo(mapInstance);

    const mapScale = L.control.scale({ position: 'bottomright', metric: true, imperial: false });
    mapScale.addTo(mapInstance);
    alignTillerLegendBetweenControls(mapInstance, legend, popupLayerControl, mapScale);
  }

  tillerBtn.addEventListener('click', async () => {
    try {
      if (!window.drawnGeoJSON) throw new Error('Please draw a polygon first.');
      if (!dateInput.value) throw new Error('Please select a date.');

      setSelectedActionButton(tillerBtn);
      showToast('Generating tiller density layer...', false, 0);
      const { cog_url, classified_cog_url, class_breaks } = await postJson('/generateTillerDensityMap/', {
        polygon: window.drawnGeoJSON.geometry,
        crs: window.crs,
        date: dateInput.value,
      });
      window.tillerCogUrl = cog_url;
      window.classifiedCogUrl = classified_cog_url || null;
      window.classBreaks = Array.isArray(class_breaks) ? class_breaks : null;
      hidePanel('tiller-density-map');
      await renderRasterOnMainMap(cog_url, 'Tiller Density');
      showToast('Tiller density map added on AOI');
    } catch (err) {
      console.error(err);
      showToast(`Failed to generate map: ${err.message || err}`, true);
    }
  });

  reportBtn.addEventListener('click', async () => {
    try {
      if (!window.tillerCogUrl) throw new Error('Generate the tiller density map first.');
      setSelectedActionButton(reportBtn);
      const cogUrl = window.tillerCogUrl;
      const classifiedCogUrl = window.classifiedCogUrl || cogUrl;
      const content = document.getElementById('report-content');
      openPanel('report-container');
      content.classList.remove('report-layout');
      content.innerHTML = '<div class="map-loading"><div class="spinner"></div><p>Building report...</p></div>';

      const statsGeoraster = await fetch(cogUrl).then(r => r.arrayBuffer()).then(parseGeoraster);
      const bandData = flattenBandValues(statsGeoraster.values[0]);
      const valid = bandData.filter(v => Number.isFinite(v) && v !== NODATA && v > 0);
      const { min, max, avg } = computeStats(valid);
      const areaHa = (turf.area(window.drawnGeoJSON)/10000).toFixed(2);

      destroyPanelMap('density-map');
      destroyPanelMap('classified-map');

      content.innerHTML = `
        <div class="report-kpis">
          <div class="kpi-card">
            <span class="kpi-label">AOI Area</span>
            <strong class="kpi-value">${formatNumber(areaHa, 2)} ha</strong>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Minimum</span>
            <strong class="kpi-value">${formatNumber(min, 2)}</strong>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Maximum</span>
            <strong class="kpi-value">${formatNumber(max, 2)}</strong>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Mean</span>
            <strong class="kpi-value">${formatNumber(avg, 2)}</strong>
          </div>
        </div>
        <div class="report-map-card">
          <div class="report-map-title">Tiller Density Map</div>
          <div id="density-map" class="report-map-canvas"></div>
        </div>
        <div class="report-map-card">
          <div class="report-map-title">Classified Tiller Density Map</div>
          <div id="classified-map" class="report-map-canvas"></div>
        </div>
      `;
      content.classList.add('report-layout');

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await renderRasterOnMap(cogUrl, 'density-map', 'Tiller Density');
      await renderClassified(classifiedCogUrl, 'classified-map', window.classBreaks);
    } catch (err) {
      console.error(err);
      document.getElementById('report-content').classList.remove('report-layout');
      document.getElementById('report-content').innerHTML = `
        <div class="map-error">
          <h4>Error Generating Report</h4>
          <p>${err.message || err}</p>
        </div>`;
      showToast('Failed to generate report', true);
    }
  });

  async function renderClassified(cogUrl, containerId, classBreaks = null) {
    const georaster = await fetch(cogUrl).then(r => r.arrayBuffer()).then(parseGeoraster);
    const classColors = ['#d73027', '#fc8d59', '#fee08b', '#1a9850'];
    let classLabels = ['Class 1', 'Class 2', 'Class 3', 'Class 4'];
    if (Array.isArray(classBreaks) && classBreaks.length === 3) {
      const q25 = Number(classBreaks[0]);
      const q50 = Number(classBreaks[1]);
      const q75 = Number(classBreaks[2]);
      if ([q25, q50, q75].every(Number.isFinite)) {
        classLabels = [
          `< ${formatNumber(q25, 2)}`,
          `${formatNumber(q25, 2)} - ${formatNumber(q50, 2)}`,
          `${formatNumber(q50, 2)} - ${formatNumber(q75, 2)}`,
          `≥ ${formatNumber(q75, 2)}`
        ];
      }
    }

    const classColorRGBA = classColors.map((hex) => {
      const rgba = chroma(hex).rgba();
      return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), 255];
    });
    const bounds = georasterBoundsToLatLngBounds(georaster);
    if (!bounds || !bounds.isValid()) {
      throw new Error('Could not determine raster bounds for map overlay.');
    }
    const overlayImageUrl = buildRasterOverlayDataUrl(georaster, (scalar) => {
      if (!Number.isFinite(scalar) || scalar === NODATA || scalar <= 0) return null;
      const classId = Math.round(scalar);
      if (classId < 1 || classId > 4) return null;
      return classColorRGBA[classId - 1];
    });
    const layer = L.imageOverlay(overlayImageUrl, bounds, { opacity: 1.0, interactive: false });
    const mapInstance = L.map(containerId).setView([44.5, -96.8], 10);
    registerPanelMap(containerId, mapInstance);
    const popupStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    });
    const popupSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Basemap: © Esri'
    }).addTo(mapInstance);
    layer.addTo(mapInstance);
    const popupLayerControl = L.control.layers(
      {
        'Satellite Basemap': popupSatellite,
        'Street Basemap': popupStreet
      },
      {
        'Classified Overlay': layer
      },
      {
        position: 'bottomleft',
        collapsed: false
      }
    ).addTo(mapInstance);
    const popupLayerControlContainer = popupLayerControl.getContainer();
    if (popupLayerControlContainer) {
      popupLayerControlContainer.classList.add('base-layer-control');
      const title = document.createElement('div');
      title.className = 'layer-control-title';
      title.textContent = 'Layers';
      popupLayerControlContainer.prepend(title);
    }

    mapInstance.fitBounds(bounds, { animate: false });
    await waitForMoveEndOrTimeout(mapInstance, 200);

    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'info legend');
      div.style.background = 'rgba(0,0,0,0.7)';
      div.style.padding = '10px';
      div.style.color = 'white';
      div.innerHTML = `
        <div style="font-size:14px; margin-bottom:6px;">Classified Tiller Density</div>
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[0]};margin-right:6px;"></span>${classLabels[0]}</div>
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[1]};margin-right:6px;"></span>${classLabels[1]}</div>
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[2]};margin-right:6px;"></span>${classLabels[2]}</div>
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[3]};margin-right:6px;"></span>${classLabels[3]}</div>`;
      return div;
    };
    legend.addTo(mapInstance);
    L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(mapInstance);
  }

})();

