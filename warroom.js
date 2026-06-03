/**
 * War Room — UI & Map Logic
 * Password gate, Leaflet map, CRUD, photos, filters, export/import
 */
(function () {
  'use strict';

  // SHA-256 hash of default password "gsmjc2025"
  // To change: echo -n "yourpassword" | shasum -a 256
  const PASSWORD_HASH = '62dfa6a1e7bac05b80a0c850126de31a29228ff5b0312b4a354795c5afdb058e';
  const SESSION_KEY = 'warroom_unlocked';

  const STAGE_COLORS = {
    'Anunciado/Preventa': '#3B82F6',
    'Excavación/Cimentación': '#F59E0B',
    'Estructura': '#EAB308',
    'Terminación': '#22C55E',
    'Terminado': '#15803D',
    'Detenido': '#EF4444'
  };

  // Commercial pipeline status — drives marker color
  const CRM_COLORS = {
    'Sin contactar': '#6B7280',
    'Contactado': '#3B82F6',
    'Visitado': '#F59E0B',
    'En negociación': '#8B5CF6',
    'Cliente': '#15803D',
    'Descartado': '#EF4444'
  };

  function crmColor(status) {
    return CRM_COLORS[status] || '#6B7280';
  }

  const PUNTA_CANA_CENTER = [18.560, -68.372];
  const DEFAULT_ZOOM = 12;

  // State
  let map = null;
  let osmLayer = null;
  let satelliteLayer = null;
  let isSatellite = false;
  let sites = [];
  let markers = {};
  let selectedSiteId = null;
  let addMode = false;
  let editingSiteId = null;
  let pendingCoords = null;
  let pendingPhotos = [];
  let existingPhotoIds = [];
  let photoObjectUrls = [];

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const passwordGate = $('#passwordGate');
  const warroomApp = $('#warroomApp');
  const passwordForm = $('#passwordForm');
  const passwordInput = $('#passwordInput');
  const passwordError = $('#passwordError');
  const siteList = $('#siteList');
  const siteCount = $('#siteCount');
  const sidebarListView = $('#sidebarListView');
  const detailPanel = $('#detailPanel');
  const detailContent = $('#detailContent');
  const siteModal = $('#siteModal');
  const siteForm = $('#siteForm');
  const addModeBanner = $('#addModeBanner');
  const toast = $('#toast');

  // --- Password Gate ---

  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function unlockApp() {
    sessionStorage.setItem(SESSION_KEY, '1');
    passwordGate.classList.add('hidden');
    warroomApp.classList.add('unlocked');
    initApp();
  }

  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    passwordError.textContent = '';
    const hash = await hashPassword(passwordInput.value);
    if (hash === PASSWORD_HASH) {
      unlockApp();
    } else {
      passwordError.textContent = 'Contraseña incorrecta';
      passwordInput.value = '';
      passwordInput.focus();
    }
  });

  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    unlockApp();
  }

  // --- App Init ---

  async function initApp() {
    initMap();
    bindEvents();
    await loadSites();
    setTimeout(() => map?.invalidateSize(), 150);
  }

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView(PUNTA_CANA_CENTER, DEFAULT_ZOOM);

    osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });

    satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '&copy; Esri' }
    );

    osmLayer.addTo(map);

    map.on('click', onMapClick);
  }

  function bindEvents() {
    $('#searchInput').addEventListener('input', renderAll);
    $('#filterCrm').addEventListener('change', renderAll);
    $('#filterStage').addEventListener('change', renderAll);
    $('#filterType').addEventListener('change', renderAll);
    $('#filterPriority').addEventListener('change', renderAll);

    $('#btnAddSite').addEventListener('click', toggleAddMode);
    $('#btnAddEmpty').addEventListener('click', toggleAddMode);

    $('#btnToggleLayer').addEventListener('click', toggleMapLayer);

    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', importData);

    $('#modalClose').addEventListener('click', closeModal);
    $('#modalCancel').addEventListener('click', closeModal);
    siteForm.addEventListener('submit', saveSite);

    const uploadZone = $('#photoUploadZone');
    const photoInput = $('#photoInput');

    uploadZone.addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', (e) => handlePhotoFiles(e.target.files));

    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      handlePhotoFiles(e.dataTransfer.files);
    });

    $('#lightboxClose').addEventListener('click', closeLightbox);
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });

    siteModal.addEventListener('click', (e) => {
      if (e.target === siteModal) closeModal();
    });

    $('#detailBack').addEventListener('click', closeDetail);
  }

  function showDetailView() {
    sidebarListView.classList.add('hidden');
    detailPanel.classList.add('open');
    setTimeout(() => map?.invalidateSize(), 300);
  }

  function showListView() {
    sidebarListView.classList.remove('hidden');
    detailPanel.classList.remove('open');
    setTimeout(() => map?.invalidateSize(), 300);
  }

  // --- Data Loading ---

  async function loadSites() {
    sites = await WarRoomDB.getAllSites();
    renderAll();
  }

  function getFilteredSites() {
    const search = $('#searchInput').value.toLowerCase().trim();
    const crm = $('#filterCrm').value;
    const stage = $('#filterStage').value;
    const type = $('#filterType').value;
    const priority = $('#filterPriority').value;

    return sites.filter((site) => {
      if (crm && site.crmStatus !== crm) return false;
      if (stage && site.stage !== stage) return false;
      if (type && site.type !== type) return false;
      if (priority && site.priority !== priority) return false;

      if (search) {
        const haystack = [
          site.name,
          site.crmStatus,
          site.developer?.name,
          site.developer?.contact,
          site.opportunityNotes,
          site.priceNotes,
          (site.tags || []).join(' ')
        ].join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      return true;
    });
  }

  function renderAll() {
    const filtered = getFilteredSites();
    renderSiteList(filtered);
    renderMarkers(filtered);
    siteCount.textContent = filtered.length;

    if (selectedSiteId && !filtered.find((s) => s.id === selectedSiteId)) {
      closeDetail();
    }
  }

  // --- Site List ---

  function renderSiteList(filtered) {
    if (filtered.length === 0) {
      siteList.innerHTML = `
        <div class="empty-list">
          <p>${sites.length === 0 ? 'No hay sitios registrados' : 'Ningún sitio coincide con los filtros'}</p>
          ${sites.length === 0 ? '<button class="btn btn-secondary btn-sm" id="btnAddEmpty">+ Agregar primer sitio</button>' : ''}
        </div>`;
      const btn = $('#btnAddEmpty');
      if (btn) btn.addEventListener('click', toggleAddMode);
      return;
    }

    siteList.innerHTML = filtered.map((site) => `
      <div class="site-card ${site.id === selectedSiteId ? 'active' : ''}" data-id="${site.id}">
        <div class="site-card-header">
          <span class="stage-dot" style="background:${crmColor(site.crmStatus)}" title="${escapeHtml(site.crmStatus || 'Sin contactar')}"></span>
          <h3>${escapeHtml(site.name)}</h3>
        </div>
        <div class="site-card-meta">
          <span style="background:${crmColor(site.crmStatus)}1a;color:${crmColor(site.crmStatus)}">${escapeHtml(site.crmStatus || 'Sin contactar')}</span>
          <span>${escapeHtml(site.stage)}</span>
          <span>${escapeHtml(site.type)}</span>
          <span class="priority-${site.priority?.toLowerCase() || 'media'}">${escapeHtml(site.priority || 'Media')}</span>
          ${site.developer?.name ? `<span>${escapeHtml(site.developer.name)}</span>` : ''}
        </div>
      </div>
    `).join('');

    siteList.querySelectorAll('.site-card').forEach((card) => {
      card.addEventListener('click', () => selectSite(card.dataset.id));
    });
  }

  // --- Map Markers ---

  function createMarkerIcon(crmStatus, selected) {
    const color = crmColor(crmStatus);
    return L.divIcon({
      className: 'warroom-marker',
      html: `<div class="warroom-marker-inner ${selected ? 'selected' : ''}" style="background:${color}"></div>`,
      iconSize: [selected ? 30 : 24, selected ? 30 : 24],
      iconAnchor: [selected ? 15 : 12, selected ? 30 : 24]
    });
  }

  function renderMarkers(filtered) {
    const filteredIds = new Set(filtered.map((s) => s.id));

    Object.keys(markers).forEach((id) => {
      if (!filteredIds.has(id)) {
        map.removeLayer(markers[id]);
        delete markers[id];
      }
    });

    filtered.forEach((site) => {
      const isSelected = site.id === selectedSiteId;
      const icon = createMarkerIcon(site.crmStatus, isSelected);

      if (markers[site.id]) {
        markers[site.id].setIcon(icon);
        markers[site.id].setLatLng([site.lat, site.lng]);
      } else {
        const marker = L.marker([site.lat, site.lng], { icon })
          .addTo(map)
          .on('click', () => selectSite(site.id));
        markers[site.id] = marker;
      }
    });
  }

  function toggleMapLayer() {
    isSatellite = !isSatellite;
    if (isSatellite) {
      map.removeLayer(osmLayer);
      satelliteLayer.addTo(map);
      $('#btnToggleLayer').textContent = 'Vista mapa';
    } else {
      map.removeLayer(satelliteLayer);
      osmLayer.addTo(map);
      $('#btnToggleLayer').textContent = 'Vista satélite';
    }
  }

  // --- Add Mode ---

  function toggleAddMode() {
    addMode = !addMode;
    $('#btnAddSite').classList.toggle('active', addMode);
    addModeBanner.classList.toggle('visible', addMode);
    map.getContainer().style.cursor = addMode ? 'crosshair' : '';
  }

  function onMapClick(e) {
    if (!addMode) return;

    pendingCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
    addMode = false;
    $('#btnAddSite').classList.remove('active');
    addModeBanner.classList.remove('visible');
    map.getContainer().style.cursor = '';

    openModal(null, pendingCoords);
  }

  // --- Select & Detail ---

  async function selectSite(id) {
    selectedSiteId = id;
    renderAll();

    const site = sites.find((s) => s.id === id);
    if (!site) return;

    map.setView([site.lat, site.lng], Math.max(map.getZoom(), 14));
    await renderDetail(site);
    showDetailView();
  }

  function closeDetail() {
    selectedSiteId = null;
    showListView();
    renderAll();
  }

  async function renderDetail(site) {
    const photos = await WarRoomDB.getPhotosBySite(site.id);
    revokePhotoUrls();

    const photoHtml = photos.length
      ? `<div class="photo-gallery">${photos.map((p) => {
          const url = URL.createObjectURL(p.blob);
          photoObjectUrls.push(url);
          return `<div class="photo-thumb" data-url="${url}"><img src="${url}" alt="${escapeHtml(p.filename)}"></div>`;
        }).join('')}</div>`
      : '<p class="no-photos">Sin fotos</p>';

    detailContent.innerHTML = `
      <div class="detail-header">
        <div class="detail-header-top">
          <h2>${escapeHtml(site.name)}</h2>
          <div class="detail-actions">
            <button class="btn btn-secondary btn-sm" id="detailEdit">Editar</button>
            <button class="btn btn-danger btn-sm" id="detailDelete">Eliminar</button>
          </div>
        </div>
        <div class="detail-badges">
          <span class="badge" style="background:${crmColor(site.crmStatus)};color:#fff">${escapeHtml(site.crmStatus || 'Sin contactar')}</span>
          <span class="badge" style="background:${STAGE_COLORS[site.stage]}20;color:${STAGE_COLORS[site.stage]}">${escapeHtml(site.stage)}</span>
          <span class="badge" style="background:var(--gris-claro)">${escapeHtml(site.type)}</span>
          <span class="badge priority-${site.priority?.toLowerCase() || 'media'}">${escapeHtml(site.priority || 'Media')} prioridad</span>
        </div>
      </div>

      <div class="detail-section">
        <h4>Desarrollador</h4>
        <div class="detail-field"><strong>Nombre</strong>${escapeHtml(site.developer?.name || '—')}</div>
        <div class="detail-field"><strong>Contacto</strong>${escapeHtml(site.developer?.contact || '—')}</div>
        <div class="detail-field"><strong>Web</strong>${site.developer?.website ? `<a href="${escapeHtml(site.developer.website)}" target="_blank" rel="noopener">${escapeHtml(site.developer.website)}</a>` : '—'}</div>
        <div class="detail-field"><strong>Unidades</strong>${escapeHtml(site.units || '—')}</div>
        <div class="detail-field"><strong>Coordenadas</strong>${site.lat.toFixed(5)}, ${site.lng.toFixed(5)}</div>
        ${site.tags?.length ? `<div class="detail-field"><strong>Etiquetas</strong>${site.tags.map((t) => `<span class="badge" style="background:var(--gris-claro);margin-right:4px">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>

      <div class="detail-section">
        <h4>Evaluación</h4>
        <div class="detail-field"><strong>Precio</strong><div class="detail-notes">${escapeHtml(site.priceNotes || '—')}</div></div>
        <div class="detail-field"><strong>Oportunidad</strong><div class="detail-notes">${escapeHtml(site.opportunityNotes || '—')}</div></div>
      </div>

      <div class="detail-section">
        <h4>Fotos (${photos.length})</h4>
        ${photoHtml}
      </div>
    `;

    $('#detailEdit').addEventListener('click', () => openModal(site.id));
    $('#detailDelete').addEventListener('click', () => deleteSite(site.id));

    detailContent.querySelectorAll('.photo-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => openLightbox(thumb.dataset.url));
    });
  }

  function revokePhotoUrls() {
    photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    photoObjectUrls = [];
  }

  // --- Modal / CRUD ---

  async function openModal(siteId, coords) {
    editingSiteId = siteId;
    pendingPhotos = [];
    existingPhotoIds = [];
    clearUploadPreview();

    if (siteId) {
      const site = sites.find((s) => s.id === siteId);
      if (!site) return;

      $('#modalTitle').textContent = 'Editar sitio';
      $('#siteName').value = site.name;
      $('#siteCrm').value = site.crmStatus || 'Sin contactar';
      $('#siteStage').value = site.stage;
      $('#siteType').value = site.type;
      $('#sitePriority').value = site.priority || 'Media';
      $('#siteUnits').value = site.units || '';
      $('#devName').value = site.developer?.name || '';
      $('#devContact').value = site.developer?.contact || '';
      $('#devWebsite').value = site.developer?.website || '';
      $('#priceNotes').value = site.priceNotes || '';
      $('#opportunityNotes').value = site.opportunityNotes || '';
      $('#siteTags').value = (site.tags || []).join(', ');
      pendingCoords = { lat: site.lat, lng: site.lng };

      const photos = await WarRoomDB.getPhotosBySite(siteId);
      existingPhotoIds = photos.map((p) => p.id);
      photos.forEach((p) => {
        addPreviewItem(URL.createObjectURL(p.blob), p.id, true);
      });
    } else {
      $('#modalTitle').textContent = 'Nuevo sitio';
      siteForm.reset();
      $('#sitePriority').value = 'Media';
      if (coords) pendingCoords = coords;
    }

    updateCoordsDisplay();
    siteModal.classList.add('open');
    $('#siteName').focus();
  }

  function closeModal() {
    siteModal.classList.remove('open');
    editingSiteId = null;
    pendingCoords = null;
    pendingPhotos = [];
    existingPhotoIds = [];
    clearUploadPreview();
    siteForm.reset();
  }

  function updateCoordsDisplay() {
    const el = $('#coordsDisplay');
    if (pendingCoords) {
      el.textContent = `Coordenadas: ${pendingCoords.lat.toFixed(5)}, ${pendingCoords.lng.toFixed(5)}`;
    } else {
      el.textContent = 'Coordenadas: — (activa modo agregar y haz clic en el mapa)';
    }
  }

  async function saveSite(e) {
    e.preventDefault();

    if (!pendingCoords) {
      showToast('Selecciona una ubicación en el mapa primero');
      return;
    }

    const tagsRaw = $('#siteTags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    const siteData = {
      id: editingSiteId || WarRoomDB.generateId(),
      name: $('#siteName').value.trim(),
      lat: pendingCoords.lat,
      lng: pendingCoords.lng,
      crmStatus: $('#siteCrm').value,
      stage: $('#siteStage').value,
      type: $('#siteType').value,
      priority: $('#sitePriority').value,
      units: $('#siteUnits').value.trim(),
      developer: {
        name: $('#devName').value.trim(),
        contact: $('#devContact').value.trim(),
        website: $('#devWebsite').value.trim()
      },
      priceNotes: $('#priceNotes').value.trim(),
      opportunityNotes: $('#opportunityNotes').value.trim(),
      tags,
      createdAt: editingSiteId ? sites.find((s) => s.id === editingSiteId)?.createdAt : undefined
    };

    if (editingSiteId) {
      const keptIds = new Set(
        [...document.querySelectorAll('#uploadPreview [data-photo-id]')]
          .map((el) => el.dataset.photoId)
          .filter(Boolean)
      );

      const allPhotos = await WarRoomDB.getPhotosBySite(editingSiteId);
      for (const photo of allPhotos) {
        if (!keptIds.has(photo.id)) {
          await WarRoomDB.deletePhoto(photo.id);
        }
      }
    }

    await WarRoomDB.saveSite(siteData);

    for (const photo of pendingPhotos) {
      await WarRoomDB.savePhoto(siteData.id, photo.blob, photo.filename);
    }

    closeModal();
    await loadSites();
    selectSite(siteData.id);
    showToast(editingSiteId ? 'Sitio actualizado' : 'Sitio creado');
  }

  async function deleteSite(id) {
    const site = sites.find((s) => s.id === id);
    if (!site) return;

    if (!confirm(`¿Eliminar "${site.name}"? Esta acción no se puede deshacer.`)) return;

    await WarRoomDB.deleteSite(id);
    closeDetail();
    await loadSites();
    showToast('Sitio eliminado');
  }

  // --- Photos ---

  async function resizeImage(file, maxWidth = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Error al procesar imagen'));
          },
          'image/jpeg',
          quality
        );
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Error al cargar imagen'));
      };

      img.src = url;
    });
  }

  async function handlePhotoFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;

    for (const file of files) {
      try {
        const blob = await resizeImage(file);
        const previewUrl = URL.createObjectURL(blob);
        const tempId = WarRoomDB.generateId();
        pendingPhotos.push({ id: tempId, blob, filename: file.name });
        addPreviewItem(previewUrl, tempId, false);
      } catch (err) {
        console.error(err);
        showToast('Error al procesar una foto');
      }
    }

    $('#photoInput').value = '';
  }

  function addPreviewItem(url, id, isExisting) {
    const container = $('#uploadPreview');
    const item = document.createElement('div');
    item.className = 'upload-preview-item';
    item.dataset.photoId = isExisting ? id : '';
    item.dataset.tempId = isExisting ? '' : id;
    item.innerHTML = `
      <img src="${url}" alt="Preview">
      <button type="button" aria-label="Eliminar">&times;</button>
    `;

    item.querySelector('button').addEventListener('click', () => {
      if (!isExisting) {
        pendingPhotos = pendingPhotos.filter((p) => p.id !== id);
      }
      URL.revokeObjectURL(url);
      item.remove();
    });

    container.appendChild(item);
  }

  function clearUploadPreview() {
    $('#uploadPreview').innerHTML = '';
    pendingPhotos = [];
  }

  // --- Lightbox ---

  function openLightbox(url) {
    $('#lightboxImg').src = url;
    $('#lightbox').classList.add('open');
  }

  function closeLightbox() {
    $('#lightbox').classList.remove('open');
    $('#lightboxImg').src = '';
  }

  // --- Export / Import ---

  async function exportData() {
    try {
      const data = await WarRoomDB.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `warroom-backup-${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exportados ${data.sites.length} sitios`);
    } catch (err) {
      console.error(err);
      showToast('Error al exportar');
    }
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const mode = sites.length > 0
        ? (confirm('¿Reemplazar todos los datos existentes?\n\nOK = Reemplazar\nCancelar = Fusionar con existentes') ? 'replace' : 'merge')
        : 'replace';

      await WarRoomDB.importAll(data, mode);
      closeDetail();
      await loadSites();
      showToast(`Importados ${data.sites.length} sitios`);
    } catch (err) {
      console.error(err);
      showToast('Error al importar — verifica el archivo');
    }

    e.target.value = '';
  }

  // --- Utilities ---

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  let toastTimeout = null;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
  }
})();
