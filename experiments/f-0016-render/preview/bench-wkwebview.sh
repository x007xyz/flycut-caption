#!/bin/zsh
# 前端预览性能（系统 WKWebView，与 Tauri macOS 端同一个 WebKit）：场景同 preview/scenarios.mjs。
# 用法：zsh preview/bench-wkwebview.sh（需先 node serve.mjs 并编译 out/wkrunner）
cd "${0:A:h}/.."
for row in $(node -e "import('./preview/scenarios.mjs').then(m=>m.SCENARIOS.forEach(s=>console.log(s.id+'|'+s.query)))"); do
  id=${row%%|*}; query=${row#*|}
  out/wkrunner "http://127.0.0.1:4716/?mode=play&$query" wkwebview/play.js out/wk-play.json 1000 700 >/dev/null || { echo "fail $id"; continue; }
  node -e "const r=JSON.parse(require('fs').readFileSync('out/wk-play.json','utf8'));const row={browser:'wkwebview',scenario:'$id',...r,date:new Date().toISOString()};console.log(JSON.stringify(row));require('fs').appendFileSync('results/preview-bench.jsonl',JSON.stringify(row)+'\n')"
done
