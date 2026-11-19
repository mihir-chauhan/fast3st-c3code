'use strict';
// Open a fresh tab in your logged-in Chrome (see session.js), for screenshots or UI checks.
//   const { open } = require('./tab'); const { page, done } = await open(); ...; await done();
// Name the tab (window.name) right after goto if other tools share the browser and may close unnamed tabs.
const { chromium } = require('playwright-core');

exports.open = async (opts = {}) => {
  const br = await chromium.connectOverCDP(process.env.C3_CDP_URL || 'http://127.0.0.1:9222');
  const page = await br.contexts()[0].newPage();
  await page.setViewportSize({ width: opts.width || 1600, height: opts.height || 1000 });
  return { page, done: async () => { await page.close(); await br.close(); } }; // br.close() only disconnects
};
