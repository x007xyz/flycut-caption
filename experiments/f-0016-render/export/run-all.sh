#!/bin/zsh
# 导出性能全量基准（20 / 60 分钟，1080p25）。顺序执行，避免互相抢 CPU。结果追加到 results/export-bench.jsonl。
# 用法：zsh export/run-all.sh（需先 node serve.mjs）
cd "${0:A:h}/.."
for d in 1200 3600; do
  node export/bench.mjs none $d anim-landscape
  node export/bench.mjs ass $d anim-landscape
  node export/bench.mjs skia $d anim-landscape
done
node export/bench.mjs skia 1200 anim-landscape --full-frame
node export/bench.mjs skia 1200 static-outline
# 方案 B（chromium）只做了 60 秒冒烟测试（0.3–0.78× 实时），维护者 2026-11-06 决定不再跑长素材
