# 40 运维

| 目录 | 内容 |
|---|---|
| `runbooks/` | 运维手册：排查和处理常见问题的步骤，例如 Host 起不来、模型下载失败、导出失败 |
| `incidents/` | 事故记录 `NNNN-<slug>.md`，编号只增不减 |

新建事故记录：

```bash
pnpm feature incident <slug> "<标题>" --feature F-0001
```

严重级别：S1 不可用 / S2 主要功能受损 / S3 次要问题。事故复盘不追究个人，可复用的教训写进 [LESSONS.md](../../LESSONS.md)。
