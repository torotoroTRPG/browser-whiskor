const _b = (typeof browser !== 'undefined') ? browser : chrome;
'use strict';
_b.devtools.panels.create('browser-whiskor', '', '../panel/panel.html');
