# LESSONS

agent 每次开工前读这份文件。它是错题本：记录返工过的、不该合并的、验证太弱的改动，以及值得照做的做法。

## 怎么记

每条格式：

```
### <一句规则，祈使句>
Why: <一段原因，说清楚当时发生了什么>
Evidence: <commit sha / issue / PR>
Seen 1× (YYYY-MM-DD)
```

- 复盘时只看三类问题：修完又返工的、压根不该合的、验证做得太糙的。
- 已有条目再次出现：在 `Seen` 上加一次并追加日期，例如 `Seen 2× (2026-10-28, 2026-11-02)`，Evidence 追加新的 sha。同一天多次只算一次。
- 出现在 **3 个不同日期**后，把规则移到 `docs/code-standards.md` 的「已转正规则」，这里只留标题和一行 `→ promoted to code-standards.md (YYYY-MM-DD)`。
- 做对的事也记，标题前加 `Done right:`，告诉后来者照这个来。

## Lessons

### 改版本号后在提交前跑一次 `cargo check`
Why: 2.0.2 的版本号提交在 `src-tauri/Cargo.toml` 的 `version` 后面多了一个逗号，TOML 不允许，导致 Windows 发版构建失败，紧接着又补了一个修复提交。手工改版本号的三处文件（`package.json`、`tauri.conf.json`、`Cargo.toml`）任何一处写坏都只有在构建时才暴露。
Evidence: 0367682 → ad00f06
Seen 1× (2026-07-10)
