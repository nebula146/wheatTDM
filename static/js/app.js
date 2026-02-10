(function() {
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrftoken = csrfMeta ? csrfMeta.getAttribute('content') : '';
  const NODATA = -99999;
  const renderedPanelMaps = new Map();
  const MAIN_MAP_RASTER_RESOLUTION = 24;
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
    clearMainTillerOverlay();
    setSelectedActionButton(null);
    maybeEnableButtons();
  });

  const dateInput = document.getElementById('date-input');
  const tillerBtn = document.getElementById('tiller-density-button');
  const reportBtn = document.getElementById('report-button');
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

  function buildColorLookup(scale, alpha = 1.0, steps = 256) {
    const colors = new Array(steps);
    for (let i = 0; i < steps; i += 1) {
      const t = i / Math.max(1, steps - 1);
      colors[i] = scale(t).alpha(alpha).css();
    }
    return colors;
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
    const colorLookup = buildColorLookup(scale, 0.92, 256);

    const normalizedValue = (val) => {
      const scalar = toScalarPixelValue(val);
      if (!Number.isFinite(scalar) || scalar === NODATA) return null;
      const denom = Math.max(1e-9, stretchMax - stretchMin);
      return Math.max(0, Math.min(1, (scalar - stretchMin) / denom));
    };

    clearMainTillerOverlay();

    const layer = new GeoRasterLayer({
      georaster,
      opacity: 1.0,
      resolution: MAIN_MAP_RASTER_RESOLUTION,
      resampleMethod: 'nearest',
      keepBuffer: 2,
      pixelValuesToColorFn: (val) => {
        const z = normalizedValue(val);
        if (z === null) return 'rgba(0,0,0,0)';
        const idx = Math.max(0, Math.min(255, Math.round(z * 255)));
        return colorLookup[idx];
      }
    });

    layer.addTo(map);
    layerControl.addOverlay(layer, 'Tiller Density Overlay');
    mainTillerLayer = layer;

    map.once('moveend', () => {
      void ensureLayerPainted(map, layer);
    });
    const bounds = layer.getBounds();
    if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [18, 18], animate: false });
    }
    await waitForMoveEndOrTimeout(map, 200);
    await ensureLayerPainted(map, layer);

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
    const colorLookup = buildColorLookup(scale, 1.0, 256);

    const normalizedValue = (val) => {
      const scalar = toScalarPixelValue(val);
      if (!Number.isFinite(scalar) || scalar === NODATA) return null;
      const denom = Math.max(1e-9, stretchMax - stretchMin);
      return Math.max(0, Math.min(1, (scalar - stretchMin) / denom));
    };

    const layer = new GeoRasterLayer({
      georaster,
      opacity: 1.0,
      resolution: PANEL_MAP_RASTER_RESOLUTION,
      resampleMethod: 'nearest',
      keepBuffer: 2,
      pixelValuesToColorFn: (val) => {
        const z = normalizedValue(val);
        if (z === null) return 'rgba(0,0,0,0)';
        const idx = Math.max(0, Math.min(255, Math.round(z * 255)));
        return colorLookup[idx];
      }
    });

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

    mapInstance.once('moveend', () => {
      void ensureLayerPainted(mapInstance, layer);
    });
    const bounds = layer.getBounds();
    if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
      mapInstance.fitBounds(bounds, { animate: false });
    }
    await waitForMoveEndOrTimeout(mapInstance, 200);
    await ensureLayerPainted(mapInstance, layer);

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

    L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(mapInstance);
  }

  tillerBtn.addEventListener('click', async () => {
    try {
      if (!window.drawnGeoJSON) throw new Error('Please draw a polygon first.');
      if (!dateInput.value) throw new Error('Please select a date.');

      setSelectedActionButton(tillerBtn);
      showToast('Generating tiller density layer...', false, 0);
      const { cog_url } = await postJson('/generateTillerDensityMap/', {
        polygon: window.drawnGeoJSON.geometry,
        crs: window.crs,
        date: dateInput.value,
      });
      window.tillerCogUrl = cog_url;
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
      const content = document.getElementById('report-content');
      openPanel('report-container');
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
          <div class="report-map-title">Continuous Density Surface</div>
          <div id="density-map" class="report-map-canvas"></div>
        </div>
        <div class="report-map-card">
          <div class="report-map-title">Classified Density (5 Classes)</div>
          <div id="classified-map" class="report-map-canvas"></div>
          <div id="classified-summary" class="class-summary"></div>
        </div>
      `;

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await renderRasterOnMap(cogUrl, 'density-map', 'Tiller Density');
      await renderClassified(cogUrl, 'classified-map', 'classified-summary');
    } catch (err) {
      console.error(err);
      document.getElementById('report-content').innerHTML = `
        <div class="map-error">
          <h4>Error Generating Report</h4>
          <p>${err.message || err}</p>
        </div>`;
      showToast('Failed to generate report', true);
    }
  });

  async function renderClassified(cogUrl, containerId, summaryId = null) {
    const georaster = await fetch(cogUrl).then(r => r.arrayBuffer()).then(parseGeoraster);
    const bandData = flattenBandValues(georaster.values[0]);
    const valid = bandData.filter(v => Number.isFinite(v) && v !== NODATA && v > 0).sort((a, b) => a - b);

    if (!valid.length) {
      throw new Error('No valid raster values available for classification.');
    }

    const q20 = quantile(valid, 0.20);
    const q40 = quantile(valid, 0.40);
    const q60 = quantile(valid, 0.60);
    const q80 = quantile(valid, 0.80);

    const classColors = ['#f7fcb9', '#d9f0a3', '#78c679', '#31a354', '#006837'];
    const classLabels = [
      `< ${formatNumber(q20, 2)}`,
      `${formatNumber(q20, 2)} - ${formatNumber(q40, 2)}`,
      `${formatNumber(q40, 2)} - ${formatNumber(q60, 2)}`,
      `${formatNumber(q60, 2)} - ${formatNumber(q80, 2)}`,
      `≥ ${formatNumber(q80, 2)}`
    ];

    const classCounts = [0, 0, 0, 0, 0];
    valid.forEach((v) => {
      if (v < q20) classCounts[0] += 1;
      else if (v < q40) classCounts[1] += 1;
      else if (v < q60) classCounts[2] += 1;
      else if (v < q80) classCounts[3] += 1;
      else classCounts[4] += 1;
    });
    const total = valid.length || 1;

    const layer = new GeoRasterLayer({
      georaster,
      opacity: 1.0,
      resolution: PANEL_MAP_RASTER_RESOLUTION,
      resampleMethod: 'nearest',
      keepBuffer: 2,
      pixelValuesToColorFn: (val) => {
        const scalar = toScalarPixelValue(val);
        if (!Number.isFinite(scalar) || scalar === NODATA || scalar <= 0) return 'rgba(0,0,0,0)';
        if (scalar < q20) return classColors[0];
        if (scalar < q40) return classColors[1];
        if (scalar < q60) return classColors[2];
        if (scalar < q80) return classColors[3];
        return classColors[4];
      }
    });
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

    mapInstance.once('moveend', () => {
      void ensureLayerPainted(mapInstance, layer);
    });
    const bounds = layer.getBounds();
    if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
      mapInstance.fitBounds(bounds, { animate: false });
    }
    await waitForMoveEndOrTimeout(mapInstance, 200);
    await ensureLayerPainted(mapInstance, layer);

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
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[3]};margin-right:6px;"></span>${classLabels[3]}</div>
        <div><span style="display:inline-block;width:16px;height:16px;background:${classColors[4]};margin-right:6px;"></span>${classLabels[4]}</div>`;
      return div;
    };
    legend.addTo(mapInstance);
    L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(mapInstance);

    if (summaryId) {
      const summaryEl = document.getElementById(summaryId);
      if (summaryEl) {
        summaryEl.innerHTML = classLabels.map((label, idx) => {
          const pct = (classCounts[idx] * 100 / total);
          return `
            <div class="class-row">
              <span class="class-color" style="background:${classColors[idx]};"></span>
              <span class="class-label">${label}</span>
              <span class="class-pct">${formatNumber(pct, 1)}%</span>
            </div>
          `;
        }).join('');
      }
    }
  }

})();

