document.addEventListener('DOMContentLoaded', () => {
  const pdfForm = document.getElementById('pdfForm');
  const dropZone = document.getElementById('dropZone');
  const zipFileInput = document.getElementById('zipFile');
  const uploadContent = document.getElementById('uploadContent');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const btnRemoveFile = document.getElementById('btnRemoveFile');
  const loadingState = document.getElementById('loadingState');
  const formSection = document.getElementById('formSection');
  const previewSection = document.getElementById('previewSection');
  const pdfFrame = document.getElementById('pdfFrame');
  const downloadBtn = document.getElementById('downloadBtn');
  const btnReset = document.getElementById('btnReset');
  const btnSubmit = document.getElementById('btnSubmit');

  // Drag & drop handlers
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0 && files[0].name.endsWith('.zip')) {
      zipFileInput.files = files;
      updateFileUI(files[0]);
    } else {
      alert('Please upload a valid .zip file containing HTML solutions');
    }
  });

  zipFileInput.addEventListener('change', () => {
    if (zipFileInput.files.length > 0) {
      updateFileUI(zipFileInput.files[0]);
    }
  });

  btnRemoveFile.addEventListener('click', (e) => {
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

  const startPageInput = document.getElementById('startPage');

  if (startPageInput) {
    startPageInput.addEventListener('input', () => {
      const val = startPageInput.value.trim();
      const num = Number(val);
      if (!val) {
        startPageInput.setCustomValidity('Start Page Number is required.');
      } else if (isNaN(num) || !Number.isInteger(num) || num < 1) {
        startPageInput.setCustomValidity('Page number must be a positive integer (1 or greater). Negative numbers, zero, and decimals are not allowed.');
      } else {
        startPageInput.setCustomValidity('');
        startPageInput.classList.remove('is-invalid');
      }
    });
  }

  // Submit form to backend
  pdfForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const startPageVal = (document.getElementById('startPage')?.value || '').trim();
    const startPageNum = Number(startPageVal);

    if (!startPageVal || isNaN(startPageNum) || !Number.isInteger(startPageNum) || startPageNum < 1) {
      alert('Validation Error: Start Page Number is mandatory and must be a positive integer (1 or greater, e.g. 11). Negative numbers, zero, or decimals are not allowed.');
      if (startPageInput) {
        startPageInput.classList.add('is-invalid');
        startPageInput.focus();
      }
      return;
    }

    if (!zipFileInput.files.length) {
      alert('Please select a ZIP file to upload.');
      return;
    }

    const formData = new FormData(pdfForm);

    // Show loading state
    pdfForm.classList.add('hidden');
    loadingState.classList.remove('hidden');

    try {
      const response = await fetch('/generate-pdf', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to generate PDF');
      }

      const blob = await response.blob();
      // Ensure blob type is explicitly application/pdf
      const pdfBlob = new Blob([blob], { type: 'application/pdf' });
      const pdfUrl = URL.createObjectURL(pdfBlob);

      const pdfObject = document.getElementById('pdfObject');
      const pdfEmbed = document.getElementById('pdfEmbed');
      const pdfFrame = document.getElementById('pdfFrame');
      const openTabBtn = document.getElementById('openTabBtn');

      if (pdfObject) pdfObject.data = pdfUrl;
      if (pdfEmbed) pdfEmbed.src = pdfUrl;
      if (pdfFrame) pdfFrame.src = pdfUrl;

      openTabBtn.href = pdfUrl;
      downloadBtn.href = pdfUrl;
      const fileNameStr = `${(formData.get('sic') || 'assignment').replace(/[^a-z0-9_-]/gi, '_')}_output.pdf`;
      downloadBtn.download = fileNameStr;

      // Show preview section
      loadingState.classList.add('hidden');
      formSection.classList.add('hidden');
      previewSection.classList.remove('hidden');

    } catch (err) {
      console.error(err);
      alert('Error generating PDF: ' + err.message);
      loadingState.classList.add('hidden');
      pdfForm.classList.remove('hidden');
    }
  });


  btnReset.addEventListener('click', () => {
    previewSection.classList.add('hidden');
    formSection.classList.remove('hidden');
    pdfForm.classList.remove('hidden');
    zipFileInput.value = '';
    uploadContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
  });
});
