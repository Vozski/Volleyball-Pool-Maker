const { join } = require('path');

/** @type {import("puppeteer").Configuration} */
module.exports = {
  // Render only keeps files inside the project folder between build and run,
  // so store the downloaded Chrome there instead of in ~/.cache
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
