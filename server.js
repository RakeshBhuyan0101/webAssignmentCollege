const path = require('path');
const fs = require('fs');

// Ensure Puppeteer cache directory is inside project folder for cloud deployments (Render, Heroku, Railway)
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, '.cache', 'puppeteer');

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;


// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'tmp', 'uploads');
const EXTRACT_DIR = path.join(__dirname, 'tmp', 'extracted');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(EXTRACT_DIR, { recursive: true });

// Shared Puppeteer Browser instance for high performance and low RAM usage
let globalBrowser = null;

async function getSharedBrowser() {
  if (globalBrowser && globalBrowser.isConnected()) {
    return globalBrowser;
  }
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    const commonPaths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        launchOptions.executablePath = p;
        break;
      }
    }
  }
  globalBrowser = await puppeteer.launch(launchOptions);
  return globalBrowser;
}

// Background cleanup helper to prevent disk accumulation
function scheduleSessionCleanup(sessionDir, delayMs = 10 * 60 * 1000) {
  setTimeout(() => {
    fs.rm(sessionDir, { recursive: true, force: true }, () => {});
  }, delayMs);
}

// Static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/session', express.static(EXTRACT_DIR));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for zip upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}.zip`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed!'));
    }
  }
});

// Helper function to recursively collect html files
function findHtmlFiles(dirPath) {
  let results = [];
  const list = fs.readdirSync(dirPath);
  list.forEach(file => {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findHtmlFiles(filePath));
    } else if (file.endsWith('.html') || file.endsWith('.htm')) {
      results.push(filePath);
    }
  });
  return results;
}

// Extract question number from filename like q1.html, q2.html, 1.html, etc.
function extractQuestionNumber(filePath) {
  const baseName = path.basename(filePath);
  const match = baseName.match(/(?:q|question)?\s*(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 999;
}

// Helper to escape HTML characters for source code display
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Clean and adapt inner HTML for output section
function processHtmlContent(htmlContent, sessionUrlPrefix, baseDirRel) {
  let processed = htmlContent;

  // Extract body content if <body> tag exists, or use whole string
  const bodyMatch = processed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let innerBody = bodyMatch ? bodyMatch[1] : processed;

  // Extract <style> blocks from <head> to preserve page-specific CSS
  let headStyles = '';
  const styleMatches = processed.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
  if (styleMatches) {
    headStyles = styleMatches.join('\n');
  }

  // Force loading="eager" on all iframes and images to prevent lazy-load blank maps/images in PDF rendering
  innerBody = innerBody.replace(/loading=["']lazy["']/gi, 'loading="eager"');

  // Rewrite relative src and href attributes (images, stylesheets, media)
  innerBody = innerBody.replace(/(src|href)=["'](?!http:\/\/|https:\/\/|data:|#|\/)([^"']+)["']/gi, (match, attr, relPath) => {
    // Avoid changing anchor links like #html
    if (relPath.startsWith('#')) return match;
    const fullRel = baseDirRel ? `${baseDirRel}/${relPath}` : relPath;
    return `${attr}="${sessionUrlPrefix}/${fullRel.replace(/\\/g, '/')}"`;
  });

  return { headStyles, innerBody };
}

// Main PDF generation route
app.post('/generate-pdf', upload.single('zipFile'), async (req, res) => {
  const sessionId = uuidv4();
  const sessionExtractDir = path.join(EXTRACT_DIR, sessionId);
  fs.mkdirSync(sessionExtractDir, { recursive: true });

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ZIP file uploaded' });
    }

    const studentName = (req.body.studentName || 'RAKESH BHUYAN').trim();
    const sic = (req.body.sic || '25MMCE44').trim();

    const titleLine1 = (req.body.titleLine1 || 'Assignment-1').trim();
    const titleLine2 = (req.body.titleLine2 || 'HTML').trim();

    const startPageRaw = req.body.startPage;
    const startPage = parseInt(startPageRaw, 10);

    if (startPageRaw === undefined || startPageRaw === null || startPageRaw.trim() === '' || isNaN(startPage) || startPage < 1 || !Number.isInteger(Number(startPageRaw))) {
      return res.status(400).json({ error: 'Start Page Number is mandatory and must be a valid positive integer (1 or greater).' });
    }

    // Extract ZIP
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(sessionExtractDir, true);

    // Find and sort all HTML files
    let htmlFilePaths = findHtmlFiles(sessionExtractDir);
    if (htmlFilePaths.length === 0) {
      return res.status(400).json({ error: 'No HTML files (e.g. q1.html, q2.html) found in the uploaded ZIP.' });
    }

    htmlFilePaths.sort((a, b) => {
      const numA = extractQuestionNumber(a);
      const numB = extractQuestionNumber(b);
      if (numA !== numB) return numA - numB;
      return a.localeCompare(b);
    });

    // Build Master HTML document matching exact layout, font family & size
    const sessionUrlPrefix = `/session/${sessionId}`;
    let questionsHtml = '';

    htmlFilePaths.forEach((filePath, index) => {
      const qNum = extractQuestionNumber(filePath) !== 999 ? extractQuestionNumber(filePath) : (index + 1);
      const rawCode = fs.readFileSync(filePath, 'utf8');
      const escapedCode = escapeHtml(rawCode);

      // Relative path from session extract dir for resolving media
      const relDir = path.dirname(path.relative(sessionExtractDir, filePath));
      const { headStyles, innerBody } = processHtmlContent(rawCode, sessionUrlPrefix, relDir === '.' ? '' : relDir);

      const isFirstQuestion = index === 0;

      questionsHtml += `
        <div class="question-block ${isFirstQuestion ? 'first-question' : ''}">
          ${headStyles}
          
          <div class="solution-heading">
            <strong>${qNum}. <u>Solution:</u></strong>
          </div>

          <div class="code-container">${escapedCode}</div>

          <div class="output-container">
            <div class="output-heading">
              <strong>Output</strong>
            </div>
            <div class="output-rendered">
              ${innerBody}
            </div>
          </div>
        </div>
      `;
    });

    const masterHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Assignment Document</title>
        <style>
          @page {
            size: A4;
            margin: 18mm 18mm 22mm 18mm;
          }
          * {
            box-sizing: border-box;
          }
          body {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 11pt;
            line-height: 1.45;
            color: #000000;
            margin: 0;
            padding: 0;
            background: #ffffff;
          }

          /* Document Title Header on Page 1 Top */
          .document-header {
            text-align: center;
            margin-top: 5px;
            margin-bottom: 25px;
          }
          .document-header h1 {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 16pt;
            font-weight: bold;
            margin: 0 0 4px 0;
            color: #000000;
          }
          .document-header h2 {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 16pt;
            font-weight: bold;
            margin: 0;
            color: #000000;
          }

          /* Question blocks */
          .question-block {
            page-break-before: always;
            break-before: page;
          }
          .question-block.first-question {
            page-break-before: avoid;
            break-before: auto;
          }

          .solution-heading {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 13pt;
            font-weight: bold;
            margin-top: 15px;
            margin-bottom: 12px;
            color: #000000;
          }

          .code-container {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 11pt;
            line-height: 1.45;
            white-space: pre-wrap;
            word-break: break-word;
            margin-bottom: 20px;
            color: #000000;
          }

          /* Output section formatting - Thumb Rule:
             1. If code ends at half page and output fits, renders on SAME page below code.
             2. If output does not fit or code ends near bottom/last line, moves automatically to NEXT page.
          */
          .output-container {
            break-inside: avoid;
            page-break-inside: avoid;
            margin-top: 15px;
            margin-bottom: 20px;
          }

          .output-heading {
            font-family: Calibri, Arial, "Segoe UI", sans-serif;
            font-size: 13pt;
            font-weight: bold;
            text-decoration: underline;
            margin-top: 15px;
            margin-bottom: 12px;
            color: #000000;
            break-after: avoid;
            page-break-after: avoid;
          }

          .output-rendered {
            font-family: Arial, sans-serif;
            margin-top: 10px;
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
          }

          /* General element formatting within outputs */
          img {
            max-width: 100%;
            height: auto;
          }

          /* Prevent page-break splitting inside output tables, forms, and containers */
          .output-rendered table,
          .output-rendered form,
          .output-rendered fieldset,
          .output-rendered tr,
          .output-rendered td,
          .output-rendered th,
          .output-rendered .undertaking,
          .output-rendered .form-group {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          .output-rendered table {
            width: 100% !important;
            max-width: 100% !important;
            border-collapse: collapse;
          }

          .output-rendered img,
          .output-rendered iframe,
          .output-rendered video,
          .output-rendered canvas {
            max-width: 100% !important;
            max-height: 480px !important;
            height: auto;
          }

          .output-rendered input[type="text"],
          .output-rendered input[type="password"],
          .output-rendered input[type="email"],
          .output-rendered input[type="number"],
          .output-rendered select,
          .output-rendered textarea {
            max-width: 100%;
            box-sizing: border-box;
          }
        </style>
      </head>
      <body>
        <div class="document-header">
          <h1>${titleLine1}</h1>
          <h2>${titleLine2}</h2>
        </div>

        ${questionsHtml}
      </body>
      </html>
    `;

    // Save master HTML for puppeteer rendering
    const masterHtmlPath = path.join(sessionExtractDir, 'master.html');
    fs.writeFileSync(masterHtmlPath, masterHtml, 'utf8');

    // Reuse shared Browser instance for speed and low RAM footprint
    const browser = await getSharedBrowser();
    const context = await browser.createBrowserContext().catch(() => null);
    const page = context ? await context.newPage() : await browser.newPage();
    let pdfUint8Array;

    try {
      await page.setViewport({ width: 1200, height: 1600 });

      // Load master HTML via local server URL with networkidle2 fallback for external resources (e.g. Google Maps)
      const masterUrl = `http://localhost:${currentPort}/session/${sessionId}/master.html`;
      await page.goto(masterUrl, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 30000 }).catch(() => {});

      // Ensure all lazy attributes are removed and trigger full scroll for map tiles
      await page.evaluate(() => {
        document.querySelectorAll('iframe, img').forEach(el => {
          el.setAttribute('loading', 'eager');
          el.removeAttribute('loading');
        });
        window.scrollTo(0, document.body.scrollHeight);
        window.scrollTo(0, 0);
      }).catch(() => {});

      // Allow time for local styles, images, and external iframes (like Google Maps) to complete rendering tiles
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Generate A4 PDF with symmetric border & header/footer
      pdfUint8Array = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        margin: {
          top: '16mm',
          bottom: '18mm',
          left: '16mm',
          right: '16mm'
        },
        headerTemplate: `
          <div style="width: 100%; height: 100%; position: relative;">
            <!-- Black Rectangular Outer Border Box - Bottom line shifted slightly upwards -->
            <div style="position: absolute; top: 6mm; left: 6mm; width: 198mm; height: 279mm; border: 1.5px solid #000000; box-sizing: border-box; pointer-events: none;"></div>
          </div>
        `,
        footerTemplate: `
          <div style="font-family: Calibri, Arial, 'Segoe UI', sans-serif; font-size: 10pt; font-weight: bold; width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 0 16mm 10mm 16mm; box-sizing: border-box; color: #000000; text-transform: uppercase;">
            <div style="float: left;">${studentName}</div>
            <div style="margin: 0 auto; visibility: hidden;"><span class="pageNumber"></span></div>
            <div style="float: right;">${sic}</div>
          </div>
        `
      });
    } finally {
      await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }

    // Clean up uploaded zip file immediately
    fs.unlink(req.file.path, () => {});

    // Schedule background cleanup of extracted session files after 10 minutes
    scheduleSessionCleanup(sessionExtractDir);

    // Use pdf-lib to overlay starting page numbers from startPage onwards
    const pdfDoc = await PDFDocument.load(pdfUint8Array);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    pages.forEach((pdfPage, idx) => {
      const pageNumStr = String(startPage + idx);
      const fontSize = 10;
      const textWidth = helveticaBold.widthOfTextAtSize(pageNumStr, fontSize);
      const { width } = pdfPage.getSize();
      
      const x = (width - textWidth) / 2;
      const y = 30; // Approx 10.5mm baseline from bottom

      pdfPage.drawText(pageNumStr, {
        x,
        y,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0)
      });
    });

    const modifiedPdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(modifiedPdfBytes);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `inline; filename="${sic}_assignment.pdf"`);
    res.end(pdfBuffer);

  } catch (err) {
    console.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Server error generating PDF: ' + err.message });
  }
});


let currentPort = parseInt(process.env.PORT, 10) || 3000;

function listenOnAvailablePort(port) {
  const server = app.listen(port, () => {
    currentPort = server.address().port;
    console.log(`Server running successfully at http://localhost:${currentPort}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is currently in use. Trying port ${port + 1}...`);
      listenOnAvailablePort(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

listenOnAvailablePort(currentPort);

