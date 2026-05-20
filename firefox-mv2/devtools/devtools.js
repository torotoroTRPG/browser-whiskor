const _b = (typeof browser !== 'undefined') ? browser : chrome;
'use strict';
_b.devtools.panels.create('Site Inspector', '', '../panel/panel.html');
