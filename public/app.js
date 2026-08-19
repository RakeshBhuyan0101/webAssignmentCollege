document.addEventListener('DOMContentLoaded', () => {
  // ─── DOM references ───────────────────────────────────────────────────────
  const pdfForm              = document.getElementById('pdfForm');
  const dropZone             = document.getElementById('dropZone');
  const zipFileInput         = document.getElementById('zipFile');
  const uploadContent        = document.getElementById('uploadContent');
  const fileInfo             = document.getElementById('fileInfo');
  const fileName             = document.getElementById('fileName');
  const fileSize             = document.getElementById('fileSize');
  const btnRemoveFile        = document.getElementById('btnRemoveFile');
  const loadingState         = document.getElementById('loadingState');
  const formSection          = document.getElementById('formSection');
  const previewSection       = document.getElementById('previewSection');
  const downloadBtn          = document.getElementById('downloadBtn');
  const btnReset             = document.getElementById('btnReset');
  const btnOpenEditor        = document.getElementById('btnOpenEditor');
  const canvasEditorSection  = document.getElementById('canvasEditorSection');
  const btnBackToPreview     = document.getElementById('btnBackToPreview');
  const canvasPagesContainer = document.getElementById('canvasPagesContainer');
  const activePageSelect     = document.getElementById('activePageSelect');
  const btnAddText           = document.getElementById('btnAddText');
  const btnAddImage          = document.getElementById('btnAddImage');
  const btnDeleteSelected    = document.getElementById('btnDeleteSelected');
  const btnRemovePage        = document.getElementById('btnRemovePage');
  const btnDownloadEdited    = document.getElementById('btnDownloadEdited');
  const startPageInput       = document.getElementById('startPage');

  // ─── App State ────────────────────────────────────────────────────────────
  let currentFormData    = null;
  let pdfArrayBuffer     = null;   // raw bytes of generated PDF
  let pdfBlobUrl         = null;   // blob URL for download / open-in-tab
  // fabricCanvases[i] = fabric.Canvas for original page i, or null if page was removed
  let fabricCanvases     = [];
  // Set of original page indices the user has deleted
  let removedPages       = new Set();
  let activeFabricIdx    = 0;      // currently active page index in editor

  // ─── ZIP drag-and-drop ────────────────────────────────────────────────────
  ['dragenter', 'dragover'].forEach(evt =>
    dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); }, false)
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); }, false)
  );
  dropZone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].name.endsWith('.zip')) {
      zipFileInput.files = files;
      updateFileUI(files[0]);
    } else {
      alert('Please upload a valid .zip file.');
    }
  });
  zipFileInput.addEventListener('change', () => {
    if (zipFileInput.files.length > 0) updateFileUI(zipFileInput.files[0]);
  });
  btnRemoveFile.addEventListener('click', e => {
    e.stopPropagation();
    zipFileInput.value = '';
    uploadContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
  });
  function updateFileUI(file) {
    fileName.textContent = file.name;
    fileSize.textContent = (file.size / 1024).toFixed(1) + ' KB';
    uploadContent.classList.add('hidden');
    fileInfo.classList.remove('hidden');
  }

  // ─── Start Page validation ────────────────────────────────────────────────
  if (startPageInput) {
    startPageInput.addEventListener('input', () => {
      const val = startPageInput.value.trim();
      const num = Number(val);
      if (!val) {
        startPageInput.setCustomValidity('Start Page Number is required.');
      } else if (isNaN(num) || !Number.isInteger(num) || num < 1) {
        startPageInput.setCustomValidity('Page number must be a positive integer (≥1).');
      } else {
        startPageInput.setCustomValidity('');
        startPageInput.classList.remove('is-invalid');
      }
    });
  }

  // ─── Form submit: Generate PDF ────────────────────────────────────────────
  pdfForm.addEventListener('submit', async e => {
    e.preventDefault();

    const startPageVal = (startPageInput?.value || '').trim();
    const startPageNum = Number(startPageVal);
    if (!startPageVal || isNaN(startPageNum) || !Number.isInteger(startPageNum) || startPageNum < 1) {
      alert('Validation Error: Start Page Number must be a positive integer (≥1).');
      if (startPageInput) { startPageInput.classList.add('is-invalid'); startPageInput.focus(); }
      return;
    }
    if (!zipFileInput.files.length) { alert('Please select a ZIP file to upload.'); return; }

    currentFormData = new FormData(pdfForm);
    pdfForm.classList.add('hidden');
    loadingState.classList.remove('hidden');

    try {
      const response = await fetch('/generate-pdf', { method: 'POST', body: currentFormData });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to generate PDF');
      }

      const blob    = await response.blob();
      const pdfBlob = new Blob([blob], { type: 'application/pdf' });

      pdfArrayBuffer = await pdfBlob.arrayBuffer();
      pdfBlobUrl     = URL.createObjectURL(pdfBlob);

      const openTabBtn = document.getElementById('openTabBtn');
      if (openTabBtn) openTabBtn.href = pdfBlobUrl;
      downloadBtn.href = pdfBlobUrl;
      const sicSafe = (currentFormData.get('sic') || 'assignment').replace(/[^a-z0-9_-]/gi, '_');
      downloadBtn.download = `${sicSafe}_output.pdf`;

      loadingState.classList.add('hidden');
      formSection.classList.add('hidden');
      previewSection.classList.remove('hidden');

      await renderPdfPages(pdfArrayBuffer);

    } catch (err) {
      console.error(err);
      alert('Error generating PDF: ' + err.message);
      loadingState.classList.add('hidden');
      pdfForm.classList.remove('hidden');
    }
  });

  // ─── PDF.js page rendering (preview section) ──────────────────────────────
  async function renderPdfPages(arrayBuffer) {
    const viewerContainer = document.getElementById('viewerContainer');
    viewerContainer.innerHTML = '<div class="viewer-loading"><div class="spinner"></div><p>Rendering PDF preview...</p></div>';
    try {
      if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
      viewerContainer.innerHTML = '';

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page     = await pdfDoc.getPage(pageNum);
        const scale    = 1.5;
        const viewport = page.getViewport({ scale });

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page-wrapper';

        const canvas = document.createElement('canvas');
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        wrapper.appendChild(canvas);
        viewerContainer.appendChild(wrapper);

        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } catch (renderErr) {
      console.error('PDF.js render error:', renderErr);
      document.getElementById('viewerContainer').innerHTML =
        `<iframe src="${pdfBlobUrl}" style="width:100%;height:80vh;border:none;border-radius:8px;"></iframe>`;
    }
  }

  // ─── Reset ────────────────────────────────────────────────────────────────
  btnReset.addEventListener('click', () => {
    previewSection.classList.add('hidden');
    canvasEditorSection.classList.add('hidden');
    formSection.classList.remove('hidden');
    pdfForm.classList.remove('hidden');
    zipFileInput.value = '';
    uploadContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    destroyFabricCanvases();
    pdfArrayBuffer = null;
    pdfBlobUrl     = null;
  });

  // ─── Open / close Canvas Editor ───────────────────────────────────────────
  btnOpenEditor.addEventListener('click', () => {
    if (!pdfArrayBuffer) { alert('PDF not ready yet.'); return; }
    previewSection.classList.add('hidden');
    canvasEditorSection.classList.remove('hidden');
    initCanvasEditor();
  });

  btnBackToPreview.addEventListener('click', () => {
    canvasEditorSection.classList.add('hidden');
    previewSection.classList.remove('hidden');
  });

  // ─── Canvas Editor — init ─────────────────────────────────────────────────

  function destroyFabricCanvases() {
    fabricCanvases.forEach(fc => { if (fc) { try { fc.dispose(); } catch (_) {} } });
    fabricCanvases = [];
    removedPages   = new Set();
    canvasPagesContainer.innerHTML = '';
    activePageSelect.innerHTML = '';
  }

  async function initCanvasEditor() {
    destroyFabricCanvases();
    activeFabricIdx = 0;

    canvasPagesContainer.innerHTML =
      '<div class="viewer-loading"><div class="spinner"></div><p>Loading PDF pages into editor…</p></div>';

    if (!window.pdfjsLib) { alert('PDF.js not available.'); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    let pdfDoc;
    try {
      pdfDoc = await pdfjsLib.getDocument({ data: pdfArrayBuffer.slice(0) }).promise;
    } catch (err) {
      alert('Could not load PDF for editing: ' + err.message);
      return;
    }

    canvasPagesContainer.innerHTML = '';
    activePageSelect.innerHTML = '';

    for (let i = 0; i < pdfDoc.numPages; i++) {
      await buildEditorPage(pdfDoc, i);
    }

    highlightActivePage(0);
    updateRemovePageBtn();
  }

  async function buildEditorPage(pdfDoc, i) {
    const page     = await pdfDoc.getPage(i + 1);
    const scale    = 1.5;
    const viewport = page.getViewport({ scale });

    // ── Page wrapper ──────────────────────────────────────────────────────
    const pageWrap = document.createElement('div');
    pageWrap.className = 'canvas-page-wrap';
    pageWrap.id = `editor-page-wrap-${i}`;

    const label = document.createElement('div');
    label.className = 'canvas-page-label';
    label.textContent = `Page ${i + 1}`;
    pageWrap.appendChild(label);

    // ── Canvas element that Fabric will own ───────────────────────────────
    const canvasEl = document.createElement('canvas');
    canvasEl.id = `fabric-canvas-${i}`;
    pageWrap.appendChild(canvasEl);
    canvasPagesContainer.appendChild(pageWrap);

    // ── Init Fabric.js ────────────────────────────────────────────────────
    const fc = new fabric.Canvas(`fabric-canvas-${i}`, {
      width:  viewport.width,
      height: viewport.height,
      selection: true,
      preserveObjectStacking: true,
    });

    // ── Render PDF page as Fabric background (the real PDF content) ───────
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width  = viewport.width;
    tempCanvas.height = viewport.height;
    await page.render({ canvasContext: tempCanvas.getContext('2d'), viewport }).promise;
    const bgDataUrl = tempCanvas.toDataURL('image/jpeg', 0.95);

    await new Promise(resolve => {
      fc.setBackgroundImage(
        bgDataUrl,
        () => { fc.renderAll(); resolve(); },
        { scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' }
      );
    });

    // ── Drag-and-drop images onto this canvas ─────────────────────────────
    const wrapEl = fc.wrapperEl;
    if (wrapEl) {
      wrapEl.addEventListener('dragover', ev => {
        ev.preventDefault(); wrapEl.classList.add('drag-over');
      });
      wrapEl.addEventListener('dragleave', () => wrapEl.classList.remove('drag-over'));
      wrapEl.addEventListener('drop', ev => {
        ev.preventDefault();
        wrapEl.classList.remove('drag-over');
        const files = ev.dataTransfer.files;
        if (files && files.length > 0 && files[0].type.startsWith('image/')) {
          const rect = wrapEl.getBoundingClientRect();
          addImageToFabric(fc, files[0], ev.clientX - rect.left, ev.clientY - rect.top);
        }
      });
    }

    // Clicking the page wrapper makes it active
    pageWrap.addEventListener('click', () => highlightActivePage(i));

    // Store in array (slot i)
    fabricCanvases[i] = fc;

    // Page selector <option>
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Page ${i + 1}`;
    opt.id = `page-opt-${i}`;
    activePageSelect.appendChild(opt);
  }

  // ─── Page navigation ──────────────────────────────────────────────────────

  function highlightActivePage(idx) {
    activeFabricIdx = idx;
    activePageSelect.value = idx;
    document.querySelectorAll('.canvas-page-wrap').forEach(wrap => {
      wrap.classList.toggle('active-page', wrap.id === `editor-page-wrap-${idx}`);
    });
    const activeWrap = document.getElementById(`editor-page-wrap-${idx}`);
    if (activeWrap) activeWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    updateRemovePageBtn();
  }

  activePageSelect.addEventListener('change', () => {
    highlightActivePage(parseInt(activePageSelect.value));
  });

  function updateRemovePageBtn() {
    // Disable Remove Page if only 1 page remains
    const remaining = fabricCanvases.filter(fc => fc !== null).length;
    btnRemovePage.disabled = remaining <= 1;
    btnRemovePage.title = remaining <= 1
      ? 'Cannot remove the last remaining page'
      : 'Remove this entire page from the PDF';
  }

  // ─── Remove Page ──────────────────────────────────────────────────────────
  btnRemovePage.addEventListener('click', () => {
    const idx = activeFabricIdx;
    const remaining = fabricCanvases.filter(fc => fc !== null).length;
    if (remaining <= 1) {
      alert('Cannot remove the last remaining page.');
      return;
    }

    const confirmed = confirm(
      `Remove Page ${idx + 1} from the PDF?\n\nThis page will be excluded when you download the edited PDF.`
    );
    if (!confirmed) return;

    // Dispose and null out the Fabric canvas
    try { fabricCanvases[idx].dispose(); } catch (_) {}
    fabricCanvases[idx] = null;
    removedPages.add(idx);

    // Remove DOM page wrap
    const pageWrap = document.getElementById(`editor-page-wrap-${idx}`);
    if (pageWrap) {
      pageWrap.classList.add('page-removed-anim');
      setTimeout(() => pageWrap.remove(), 300);
    }

    // Remove from <select>
    const opt = document.getElementById(`page-opt-${idx}`);
    if (opt) opt.remove();

    // Move active page to the nearest remaining page
    const nextActive = findNextActivePage(idx);
    if (nextActive !== -1) {
      setTimeout(() => highlightActivePage(nextActive), 350);
    }

    updateRemovePageBtn();
  });

  function findNextActivePage(removedIdx) {
    // Try next page first, then previous
    for (let i = removedIdx + 1; i < fabricCanvases.length; i++) {
      if (fabricCanvases[i] !== null) return i;
    }
    for (let i = removedIdx - 1; i >= 0; i--) {
      if (fabricCanvases[i] !== null) return i;
    }
    return -1;
  }

  // ─── Add Text ─────────────────────────────────────────────────────────────
  btnAddText.addEventListener('click', () => {
    const fc = fabricCanvases[activeFabricIdx];
    if (!fc) { alert('No active page.'); return; }

    const txt = new fabric.IText('Double-click to edit', {
      left: 60,
      top: 60,
      fontFamily: 'Arial, sans-serif',
      fontSize: 16,
      fill: '#000000',
      padding: 4,
      cornerSize: 8,
      transparentCorners: false,
      borderColor: '#38bdf8',
      cornerColor: '#38bdf8',
      editingBorderColor: '#38bdf8',
    });

    fc.add(txt);
    fc.setActiveObject(txt);
    fc.renderAll();
    txt.enterEditing();
  });

  // ─── Add Image ────────────────────────────────────────────────────────────
  btnAddImage.addEventListener('change', () => {
    const file = btnAddImage.files[0];
    if (!file) return;
    const fc = fabricCanvases[activeFabricIdx];
    if (!fc) { alert('No active page.'); return; }
    addImageToFabric(fc, file, fc.width / 2, fc.height / 2);
    btnAddImage.value = '';
  });

  function addImageToFabric(fc, file, x, y) {
    const reader = new FileReader();
    reader.onload = ev => {
      fabric.Image.fromURL(ev.target.result, img => {
        const maxW = fc.width * 0.4;
        if (img.width > maxW) img.scale(maxW / img.width);
        img.set({
          left: Math.max(10, x - img.getScaledWidth() / 2),
          top:  Math.max(10, y - img.getScaledHeight() / 2),
          cornerSize: 8,
          transparentCorners: false,
          borderColor: '#38bdf8',
          cornerColor: '#38bdf8',
        });
        fc.add(img);
        fc.setActiveObject(img);
        fc.renderAll();
      });
    };
    reader.readAsDataURL(file);
  }

  // ─── Delete Selected element ──────────────────────────────────────────────
  btnDeleteSelected.addEventListener('click', () => {
    const fc = fabricCanvases[activeFabricIdx];
    if (!fc) return;
    const active = fc.getActiveObjects();
    if (!active || active.length === 0) { alert('Select an element first.'); return; }
    active.forEach(obj => fc.remove(obj));
    fc.discardActiveObject();
    fc.renderAll();
  });

  // Keyboard delete / backspace
  document.addEventListener('keydown', e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') &&
        document.activeElement.tagName !== 'INPUT' &&
        document.activeElement.tagName !== 'TEXTAREA' &&
        document.activeElement.contentEditable !== 'true') {
      const fc = fabricCanvases[activeFabricIdx];
      if (!fc) return;
      const active = fc.getActiveObjects();
      if (active && active.length > 0 && !active.some(o => o.isEditing)) {
        active.forEach(obj => fc.remove(obj));
        fc.discardActiveObject();
        fc.renderAll();
      }
    }
  });

  // ─── Download Edited PDF ──────────────────────────────────────────────────
  // 1. Load original PDF.
  // 2. For each page NOT removed: export only user-added overlay as transparent PNG → draw on PDF page.
  // 3. Remove deleted pages (in reverse order so indices stay stable).
  // 4. Save & download.
  btnDownloadEdited.addEventListener('click', async () => {
    if (!pdfArrayBuffer || fabricCanvases.length === 0) {
      alert('No PDF loaded or editor not initialized.');
      return;
    }

    const originalHTML = btnDownloadEdited.innerHTML;
    btnDownloadEdited.disabled = true;
    btnDownloadEdited.innerHTML = '<span class="spinner-inline"></span> Generating…';

    try {
      if (!window.PDFLib) throw new Error('pdf-lib not loaded. Check your internet connection.');
      const { PDFDocument } = PDFLib;

      const pdfDoc = await PDFDocument.load(pdfArrayBuffer.slice(0));
      const pages  = pdfDoc.getPages();

      // Step 1: apply overlays to pages that have user-added objects (and aren't removed)
      for (let i = 0; i < fabricCanvases.length && i < pages.length; i++) {
        if (removedPages.has(i)) continue;           // skip removed pages
        const fc = fabricCanvases[i];
        if (!fc) continue;
        const objects = fc.getObjects();
        if (!objects || objects.length === 0) continue; // no changes on this page

        const pdfPage = pages[i];
        const { width: pW, height: pH } = pdfPage.getSize();

        // Export only the overlay (temporarily hide background)
        const savedBg = fc.backgroundImage;
        fc.backgroundImage = null;
        fc.backgroundColor = '';
        fc.renderAll();

        const overlayDataUrl = fc.toDataURL({ format: 'png', multiplier: 1 });

        // Restore background
        fc.backgroundImage = savedBg;
        fc.renderAll();

        const overlayBytes = dataUrlToBytes(overlayDataUrl);
        const pngImage     = await pdfDoc.embedPng(overlayBytes);
        pdfPage.drawImage(pngImage, { x: 0, y: 0, width: pW, height: pH, opacity: 1 });
      }

      // Step 2: remove pages in REVERSE order (so earlier indices stay stable)
      const sortedRemoved = [...removedPages].sort((a, b) => b - a);
      sortedRemoved.forEach(idx => {
        if (idx < pdfDoc.getPageCount()) {
          pdfDoc.removePage(idx);
        }
      });

      const modifiedBytes = await pdfDoc.save();
      const blob = new Blob([modifiedBytes], { type: 'application/pdf' });
      const url  = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      const sicSafe = currentFormData
        ? (currentFormData.get('sic') || 'assignment').replace(/[^a-z0-9_-]/gi, '_')
        : 'assignment';
      a.download = `${sicSafe}_edited.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 15000);

    } catch (err) {
      console.error('Error generating edited PDF:', err);
      alert('Error: ' + err.message);
    } finally {
      btnDownloadEdited.disabled = false;
      btnDownloadEdited.innerHTML = originalHTML;
    }
  });

  // ─── Utility ──────────────────────────────────────────────────────────────
  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary  = atob(base64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
});
