/**
 * server/mcp/tools/read.js
 * READカテゴリのMCPツール定義とハンドラ（サブモジュールを束ねるエントリポイント）。
 */
'use strict';
module.exports = function registerReadTools(registry) {
  require('./read-basic')(registry);
  require('./read-data')(registry);
  require('./read-state')(registry);
};
