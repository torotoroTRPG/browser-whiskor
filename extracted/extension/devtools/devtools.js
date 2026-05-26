'use strict';
chrome.devtools.panels.create('browser-whiskor', '', '../panel/panel.html');
// CSS Origin Level 1 bridge is handled in panel/panel.js (onCssOriginResourceRequest)
// because the panel port is owned there and getResources() is available in all
// DevTools page contexts.
