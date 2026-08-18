const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Store Puppeteer Chrome cache inside project directory for Cloud/Render hosting
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
