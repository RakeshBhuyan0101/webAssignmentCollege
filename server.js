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

// Clean and normalize HTML source code for aligned, beautiful code container display
function cleanHtmlSourceCode(rawCode) {
  if (!rawCode) return '';
  let code = rawCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Replace tabs with 2 spaces
  code = code.replace(/\t/g, '  ');

  // Protect <pre>, <code>, <script>, <style>, <textarea> blocks from whitespace modification
  const protectedBlocks = [];
  code = code.replace(/<(pre|code|script|style|textarea)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
    const placeholder = `___PROTECTED_BLOCK_${protectedBlocks.length}___`;
    protectedBlocks.push(match);
    return placeholder;
  });

  // For text content between tags (e.g. Lorem ipsum inside <td> or <p>):
  // Collapse broken multiline breaks and excessive indentation into single spaces so code doesn't staircase
  code = code.replace(/>([^<]+)</g, (match, textContent) => {
    if (/^\s+$/.test(textContent)) {
      const lines = textContent.split('\n');
      if (lines.length > 1) {
        return `>\n${lines[lines.length - 1]}<`;
      }
      return match;
    }

    const leadingWs = textContent.match(/^\s*/)[0];
    const trailingWs = textContent.match(/\s*$/)[0];
    const trimmed = textContent.trim();
    const cleanedText = trimmed.replace(/\s*\n\s*/g, ' ');

    let prefix = '';
    if (leadingWs.includes('\n')) {
      prefix = '\n' + leadingWs.split('\n').pop();
    } else if (leadingWs.length > 0) {
      prefix = ' ';
    }

    let suffix = '';
    if (trailingWs.includes('\n')) {
      suffix = '\n' + trailingWs.split('\n').pop();
    } else if (trailingWs.length > 0) {
      suffix = ' ';
    }

    return `>${prefix}${cleanedText}${suffix}<`;
  });

  // Restore protected blocks
  protectedBlocks.forEach((block, idx) => {
    code = code.replace(`___PROTECTED_BLOCK_${idx}___`, block);
  });

  // Limit consecutive blank lines
  code = code.replace(/\n{3,}/g, '\n\n');
  return code.trim();
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

  // Convert marquee tags to static visible containers so text is never scrolled off or clipped
  innerBody = innerBody.replace(/<marquee([^>]*)>([\s\S]*?)<\/marquee>/gi, (match, attrs, content) => {
    let bgColorStyle = '';
    const bgMatch = attrs.match(/bgcolor=["']?([^"'\s>]+)["']?/i);
    if (bgMatch) {
      bgColorStyle = `background-color: ${bgMatch[1]}; `;
    }
    let existingStyle = '';
    const styleMatch = attrs.match(/style=["']([^"']*)["']/i);
    if (styleMatch) {
      existingStyle = styleMatch[1];
      if (!existingStyle.trim().endsWith(';')) existingStyle += '; ';
    }
    return `<div ${attrs} style="${existingStyle}${bgColorStyle}display:block !important; width:100% !important; overflow:visible !important; white-space:normal !important;">${content}</div>`;
  });

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

    // ── Pass 1: Screenshot each HTML file's rendered output ────────────────
    // Each screenshot is embedded as a JPEG data-URL so the output behaves
    // as a single atomic image block — no internal page-breaks, and it scales
    // cleanly to fit remaining space on the same page as the code.
    const screenshotBrowser = await getSharedBrowser();
    const ssContext = await screenshotBrowser.createBrowserContext().catch(() => null);
    const ssPage = ssContext ? await ssContext.newPage() : await screenshotBrowser.newPage();
    const outputScreenshots = []; // one entry per HTML file (data-URL string | null)

    try {
      // 900px wide = slightly narrower than A4 text area rendered at 96dpi
      // deviceScaleFactor 1.5 → crisp output without making the file huge
      await ssPage.setViewport({ width: 900, height: 1100, deviceScaleFactor: 1.5 });

      for (const filePath of htmlFilePaths) {
        const relFilePath = path.relative(sessionExtractDir, filePath).replace(/\\/g, '/');
        const fileUrl = `http://localhost:${currentPort}/session/${sessionId}/${relFilePath}`;

        try {
          await ssPage.goto(fileUrl, {
            waitUntil: ['domcontentloaded', 'networkidle2'],
            timeout: 15000
          }).catch(() => {});

          // Eager-load all media and freeze marquee tags statically for complete visibility
          await ssPage.evaluate(() => {
            document.querySelectorAll('iframe, img').forEach(el => {
              el.setAttribute('loading', 'eager');
              el.removeAttribute('loading');
            });

            // Convert marquee elements into static block elements so text is 100% visible
            document.querySelectorAll('marquee').forEach(m => {
              try { if (typeof m.stop === 'function') m.stop(); } catch(_) {}
              const div = document.createElement('div');
              div.innerHTML = m.innerHTML;
              if (m.getAttribute('bgcolor')) {
                div.style.backgroundColor = m.getAttribute('bgcolor');
              }
              if (m.getAttribute('style')) {
                div.style.cssText = m.getAttribute('style') + ';';
                if (m.getAttribute('bgcolor')) div.style.backgroundColor = m.getAttribute('bgcolor');
              }
              div.className = m.className || '';
              div.style.display = 'block';
              div.style.width = '100%';
              div.style.overflow = 'visible';
              div.style.whiteSpace = 'normal';
              div.style.boxSizing = 'border-box';
              m.parentNode.replaceChild(div, m);
            });
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));

          // Calculate the actual content bounding height so short outputs don't produce huge empty canvases
          const contentBounds = await ssPage.evaluate(() => {
            const body = document.body;
            if (!body) return null;

            let maxBottom = 0;
            const elements = body.querySelectorAll('*');
            elements.forEach(el => {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return;
              const rect = el.getBoundingClientRect();
              if (rect.bottom > maxBottom) maxBottom = rect.bottom;
            });

            const docHeight = Math.max(document.documentElement.scrollHeight, body.scrollHeight);
            const finalHeight = maxBottom > 0 ? Math.max(maxBottom + 25, 60) : Math.max(docHeight, 100);

            return {
              width: 900,
              height: Math.ceil(Math.min(finalHeight, 3500))
            };
          }).catch(() => null);

          const screenshotOptions = {
            type: 'jpeg',
            quality: 90,
            encoding: 'base64'
          };

          if (contentBounds && contentBounds.height > 10) {
            screenshotOptions.clip = {
              x: 0,
              y: 0,
              width: 900,
              height: contentBounds.height
            };
          }

          const screenshotBase64 = await ssPage.screenshot(screenshotOptions);
          const base64Str = typeof screenshotBase64 === 'string'
            ? screenshotBase64
            : Buffer.from(screenshotBase64).toString('base64');

          outputScreenshots.push('data:image/jpeg;base64,' + base64Str);
        } catch (ssErr) {
          console.warn('Output screenshot failed for', path.basename(filePath), ':', ssErr.message);
          outputScreenshots.push(null); // fallback to inline HTML
        }
      }
    } finally {
      await ssPage.close().catch(() => {});
      if (ssContext) await ssContext.close().catch(() => {});
    }

    // ── Pass 2: Build master HTML with output screenshots ──────────────────
    let questionsHtml = '';

    htmlFilePaths.forEach((filePath, index) => {
      const qNum = extractQuestionNumber(filePath) !== 999 ? extractQuestionNumber(filePath) : (index + 1);
      const rawCode = fs.readFileSync(filePath, 'utf8');
      const cleanedCode = cleanHtmlSourceCode(rawCode);
      const escapedCode = escapeHtml(cleanedCode);

      // Still process HTML for headStyles (page-level CSS) and fallback innerBody
      const relDir = path.dirname(path.relative(sessionExtractDir, filePath));
      const { headStyles, innerBody } = processHtmlContent(rawCode, sessionUrlPrefix, relDir === '.' ? '' : relDir);

      const isFirstQuestion = index === 0;
      const outputImgSrc = outputScreenshots[index];

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
            ${outputImgSrc
              ? `<img src="${outputImgSrc}" class="output-screenshot" alt="Output for Question ${qNum}">`
              : `<div class="output-rendered">${innerBody}</div>`
            }
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
            margin: 18mm 20mm 22mm 20mm;
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
            tab-size: 2;
            -moz-tab-size: 2;
            text-align: left;
            margin-bottom: 20px;
            color: #000000;
          }

          /* Marquee styling for fallback rendering */
          marquee, .marquee-static {
            display: block !important;
            overflow: visible !important;
            white-space: normal !important;
            width: 100% !important;
            height: auto !important;
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

          /* General element formatting */
          img {
            max-width: 100%;
            height: auto;
          }

          /* ── Output Screenshot Image ─────────────────────────────────────
             The entire rendered HTML output is embedded as a single JPEG.
             - width: 100%  → fills text-area width
             - height: auto → preserves aspect ratio (no distortion)
             - max-height: 230mm → caps at ~1 A4 page; prevents one huge
               output from pushing everything off-screen
             - display:block + margin:auto centres it
             This means:
             • If code ends with a few lines left on the page, the output
               image starts there and continues on the same page.
             • break-inside:avoid on .output-container keeps the heading
               and the image together as one atomic block.
          */
          .output-screenshot {
            display: block;
            width: 100%;
            height: auto;
            max-height: 230mm;
            object-fit: contain;
            object-position: top left;
            margin-top: 6px;
          }

          /* Fallback: inline HTML output (used only when screenshot fails) */
          .output-rendered {
            font-family: Arial, sans-serif;
            margin-top: 10px;
            width: 100%;
            max-width: 100%;
            box-sizing: border-box;
          }

          /* Prevent page-break splitting inside fallback output tables/forms */
          .output-rendered table,
          .output-rendered form,
          .output-rendered fieldset,
          .output-rendered tr,
          .output-rendered td,
          .output-rendered th {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          .output-rendered table {
            width: 100% !important;
            max-width: 100% !important;
            border-collapse: collapse;
          }

          /* Images, videos, canvases inside fallback output — scale to fit */
          .output-rendered img,
          .output-rendered video,
          .output-rendered canvas {
            max-width: 100% !important;
            max-height: 480px !important;
            height: auto;
          }

          /* Iframes inside fallback — preserve declared height, never auto */
          .output-rendered iframe {
            max-width: 100% !important;
            max-height: 520px !important;
            min-height: 300px;
            width: 100% !important;
            display: block;
            border: none;
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

      // Ensure all lazy attributes are removed and scroll slowly to trigger map tiles
      await page.evaluate(() => {
        document.querySelectorAll('iframe, img').forEach(el => {
          el.setAttribute('loading', 'eager');
          el.removeAttribute('loading');
        });
        // Scroll to bottom to trigger lazy-loaded/map-tile resources
        window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});

      // Give map iframes extra time: scroll in steps so tile requests fire progressively
      await new Promise(resolve => setTimeout(resolve, 2000));
      await page.evaluate(() => {
        // Slow step-scroll back to top — map tiles fire as sections come into viewport
        const steps = 8;
        const step = document.body.scrollHeight / steps;
        let pos = document.body.scrollHeight;
        const interval = setInterval(() => {
          pos = Math.max(0, pos - step);
          window.scrollTo(0, pos);
          if (pos <= 0) clearInterval(interval);
        }, 300);
      }).catch(() => {});

      // Final wait for last tile requests and iframe paint to complete
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Generate A4 PDF with symmetric border & header/footer
      pdfUint8Array = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        margin: {
          top: '16mm',
          bottom: '18mm',
          left: '18mm',
          right: '18mm'
        },
        headerTemplate: `
          <div style="width: 100%; height: 100%; position: relative;">
            <!-- Black Rectangular Outer Border Box - Left 10mm, Right 10mm (width 190mm) -->
            <div style="position: absolute; top: 6mm; left: 10mm; width: 190mm; height: 279mm; border: 1.5px solid #000000; box-sizing: border-box; pointer-events: none;"></div>
          </div>
        `,
        footerTemplate: `<div></div>`
      });
    } finally {
      await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }

    // Clean up uploaded zip file immediately
    fs.unlink(req.file.path, () => {});

    // Schedule background cleanup of extracted session files after 10 minutes
    scheduleSessionCleanup(sessionExtractDir);

    // Use pdf-lib to render the entire footer (Name, Page Number, SIC) on the exact same vertical baseline
    const pdfDoc = await PDFDocument.load(pdfUint8Array);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const nameText = studentName.toUpperCase();
    const sicText  = sic.toUpperCase();
    const fontSize = 10;
    const marginPt = 18 * (72 / 25.4); // 18mm = 51.02pt matching page margins
    const footerY  = 32; // Exact uniform baseline across all 3 footer items

    pages.forEach((pdfPage, idx) => {
      const pageNumStr = String(startPage + idx);
      const { width } = pdfPage.getSize();

      // 1. Left: Student Name
      pdfPage.drawText(nameText, {
        x: marginPt,
        y: footerY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0)
      });

      // 2. Center: Page Number (startPage + idx)
      const numWidth = helveticaBold.widthOfTextAtSize(pageNumStr, fontSize);
      const centerX = (width - numWidth) / 2;
      pdfPage.drawText(pageNumStr, {
        x: centerX,
        y: footerY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0)
      });

      // 3. Right: SIC
      const sicWidth = helveticaBold.widthOfTextAtSize(sicText, fontSize);
      const rightX = width - marginPt - sicWidth;
      pdfPage.drawText(sicText, {
        x: rightX,
        y: footerY,
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

