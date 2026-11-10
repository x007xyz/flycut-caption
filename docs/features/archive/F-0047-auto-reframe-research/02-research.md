---
id: F-0047
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0047 竖屏重新构图调研：调研报告

调研日期：2026-11-09。范围是单人口播的竖屏重新构图选型，不实现生产功能。

## 摘要

建议把默认运行时收敛到 **Host 内的 onnxruntime-node + 许可干净的 ONNX 人脸检测器**，先以 OpenCV Zoo 的 YuNet 作为基准候选；不建议把 PyTorch、MediaPipe Python 或 Ultralytics YOLO 作为随安装包分发的默认路径。onnxruntime-node 是当前架构里唯一不需要额外 Python 进程、又能由 Host 插件直接调用的候选。

许可上必须先卡两道门：

- **默认不引入 AGPL 的 Ultralytics YOLO。** Ultralytics 仓库和模型以 AGPL-3.0 发布，商用需要单独的 Enterprise License；导出成 ONNX 不等于许可问题消失。KazKozDev/auto-vertical-reframe、FrameShift 的对象检测路径都受这一条影响。
- **默认不使用 InsightFace 的 buffalo_l 等模型权重。** InsightFace 代码是 MIT，但其训练数据和模型明确写着仅限非商业研究；buffalo_l 约 280 MB。algometrix/vertical_video_convertor 和 pyautoflip 的默认人脸路径都依赖它，不能直接随 FlyCut 分发。

算法上，四个候选里最接近本需求的是 algometrix：单人主脸、粘性选择、短暂丢失保持、refocus band、速度上限和镜头切换吸附。FrameShift 是每个镜头固定一个裁切框，不适合会移动的单人口播；pyautoflip 的 saliency 和分屏适合作为后续多人/复杂场景参考；KazKozDev 的相机路径和 ByteTrack 设计可参考，但其 YOLO 许可、macOS-only 实测和未测试 Windows 使它不能作为默认实现。

路径数据建议定义成一份**源媒体时间上的 `CropPath`**：归一化裁切矩形、EDL 指纹、源尺寸/帧率和少量关键帧；预览和导出共用同一个纯函数求值器。导出时把路径按 EDL 映射到输出帧时钟，生成逐帧裁切计划，再交给 FFmpeg 的 crop 命令。设计上预览与导出可以做到同一帧同一矩形，但本报告**没有实测**；FFmpeg 的 crop 命令定时、29.97 fps 的有理数时钟和 EDL 拼接边界是必须先验证的三个风险点。

真实视频评测、Mac/Windows 运行、安装包增量和 FFmpeg 抽帧一致性全部 **Not run**。本报告只给出可复现的评测协议和建议门槛，不把协议当成结果。

## 要回答的问题

来自 [01-spec.md](01-spec.md)：

- **Q-1**：本地视觉推理运行时和模型在 Mac/Windows 是否可部署，代码/权重商用与分发许可如何？仅用许可合适候选，不引入 AGPL Ultralytics YOLO。
- **Q-2**：对真实单人口播（移动、短暂离场、遮挡、侧脸）评测主体留框率、裁切抖动、错误目标、耗时与内存，人工标注和指标可复现。
- **Q-3**：检测丢失、多人出现和镜头切换时如何回退居中或固定位置；平滑、边界约束与推近推远如何避免突跳？
- **Q-4**：同一裁切路径数据能否用于浏览器预览与 FFmpeg 导出，时间与 EDL 如何映射，两端抽帧一致性是否可达？
- **Q-5**：写运行时/路径数据 ADR、支持矩阵与落地验收门槛；多人按说话人切换与双人分屏只记录后续，不纳入本次实现承诺。

## 评估标准

按下面的顺序比较，前一项是后一项的前提：

1. **许可**：代码许可和模型权重许可分开看；默认发行只接受 MIT、Apache-2.0、BSD-3-Clause 这类可商用许可，且能随安装包分发。AGPL/GPL、非商业研究权重、来源不清的权重直接排除。
2. **部署形态**：能否在现有 Host（Node/Cordis）里运行，是否要求额外 Python、系统 FFmpeg、Bazel 或浏览器 WASM；是否符合 [decisions.md](../../decisions.md) 的“客户端只内置 sherpa-onnx、Host 不启动/不打包 Python”。
3. **平台**：macOS（Apple Silicon 优先，Intel 次之）和 Windows x64 能否安装、运行、打包；没有真机就写 Not run，不按“应该可以”当成支持。
4. **质量证据**：是否有真实视频演示、可复现评测或明确限制；仓库星数和 README 宣传不能替代留框率/抖动数据。
5. **资源**：包大小、安装增量、分析耗时、峰值内存、是否需要 GPU；包大小按 wheel/npm 元数据记录，安装包增量必须实测。
6. **可维护性**：最近推送、版本、测试、依赖是否固定、上游是否退役；个人项目只能作为参考实现，不直接当前提。
7. **隐私**：默认本地推理，不上传视频；任何云端视觉服务不在本轮默认路径。
8. **可复用性**：裁切路径能否被预览和导出共同消费，能否随 EDL/源媒体变化明确失效。

## 候选方案

| 方案 | 实际做什么 | 运行时 | 代码许可 | 权重/模型许可 | 结论 |
|---|---|---|---|---|---|
| [algometrix/vertical_video_convertor](https://github.com/algometrix/vertical_video_convertor) | InsightFace buffalo_l 单人主脸；粘性选择、丢失保持、refocus band、速度上限、镜头切换吸附 | Python + onnxruntime + OpenCV + FFmpeg | MIT | InsightFace 模型仅非商业研究 | 算法参考；默认不采用 |
| [fralapo/FrameShift](https://github.com/fralapo/FrameShift) | 每个镜头一个固定裁切框；YOLO face + MediaPipe fallback；可选对象权重 | Python + PyTorch/Ultralytics + MediaPipe + FFmpeg | MIT | `yolov11n-face.pt` 来自 GPL-3.0 的 yolo-face；对象模型来自 Ultralytics | 只可参考“按镜头裁切”；默认不采用 |
| [AhmedHisham1/pyautoflip](https://github.com/AhmedHisham1/pyautoflip) | 场景检测、UNISAL saliency、InsightFace、MediaPipe 对象、平滑、双人分屏 | Python + PyTorch + onnxruntime + MediaPipe + FFmpeg | MIT | InsightFace 非商业；UNISAL 权重许可待核实 | 复杂场景/后续分屏参考；默认不采用 |
| [KazKozDev/auto-vertical-reframe](https://github.com/KazKozDev/auto-vertical-reframe) | YOLOv11-seg + ByteTrack + MediaPipe face/pose + 场景切分 + 平滑相机路径 | Python + PyTorch + Ultralytics + MediaPipe | MIT | Ultralytics YOLO 为 AGPL-3.0 或企业许可 | 明确不默认采用；仅参考路径/预设 |
| [MediaPipe AutoFlip](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/autoflip.md) | Google 原版 saliency-aware cropping | C++/Bazel + OpenCV 3 | Apache-2.0 | 图内模型需逐个核对 | 已停止支持；不采用 |
| ONNX Runtime + YuNet（建议基准） | Host 内 ONNX 人脸检测 + 自研跟踪/平滑/路径 | Node native addon（onnxruntime-node） | MIT（运行时）；YuNet 目录 MIT | YuNet 模型 MIT | 建议先做实测的默认候选 |

候选仓库的维护状态（GitHub API 读取，2026-11-09）：

| 仓库 | 最近推送 | Stars | 备注 |
|---|---:|---:|---|
| algometrix/vertical_video_convertor | 2026-07-20 | 1 | 个人项目，README 和参数说明完整；无真实质量数据 |
| fralapo/FrameShift | 2026-06-18 | 15 | README 自述“每个镜头固定裁切”，不解决移动主体 |
| AhmedHisham1/pyautoflip | 2026-10-21 | 24 | 依赖较重；README 自述 MediaPipe AutoFlip 已不再积极支持 |
| KazKozDev/auto-vertical-reframe | 2026-10-04 | 25 | 明确写 macOS tested、Windows/Linux untested、无自动化测试 |
| google-ai-edge/mediapipe | 2026-11-07 | 37.6k | 仓库整体活跃，但 AutoFlip 作为 legacy solution 于 2023-03-01 停止支持 |

## 实验

### 本报告实际做了什么

只做了资料核实，没有运行模型或视频：

- 读取四个候选仓库的 README、依赖清单和许可文件。
- 读取 MediaPipe AutoFlip 官方文档，确认 legacy 状态和 OpenCV 3/Bazel 限制。
- 读取 InsightFace README 的代码/模型许可段落、Ultralytics LICENSE 和 README 的 AGPL/Enterprise 段落、yolo-face 仓库元数据。
- 读取 ONNX Runtime、PyTorch、OpenCV Zoo、UNI-SAL、TalkNet-ASD、LoCoNet 的仓库元数据/许可。
- 读取 PyPI 和 npm 的版本与包大小元数据；这些是包大小，不是安装包增量。
- 读取 arXiv API 的论文标题、编号和日期。

### Not run

| 项目 | 状态 | 原因 |
|---|---|---|
| ONNX Runtime + YuNet 在 macOS 的真实推理 | Not run | 本机未安装该运行时/模型；本轮未改代码 |
| 同一组合在 Windows x64 的安装与推理 | Not run | 无 Windows 环境 |
| 四个 Python 候选的真实视频对比 | Not run | 未安装 PyTorch/MediaPipe/InsightFace/Ultralytics；部分权重许可不允许默认使用 |
| 真实单人口播的留框率、抖动、错误目标 | Not run | 没有经授权的标注素材和人工标注 |
| 分析耗时、CPU、峰值内存 | Not run | 未运行模型 |
| 安装包增量 | Not run | 未做 Tauri/Windows 打包；只有 wheel/npm 包大小 |
| 预览与 FFmpeg 抽帧一致性 | Not run | 路径契约尚未实现；FFmpeg crop 命令定时未验证 |
| FFmpeg 29.97/25/30 fps 的帧边界 | Not run | 未做逐帧夹具 |

### Q-2 真实视频评测协议

下面是建议协议，所有指标都必须由标注和日志计算；本报告没有产生任何数值。

**素材**：12 段 20–60 秒的横屏单人口播，覆盖 6 类条件，每类 2 段：静止、左右移动、短暂离场、遮挡（手/麦克风/物体）、侧脸、镜头切换。优先使用项目自有或明确授权的素材；分辨率至少 720p，尽量包含 1080p、25/30/29.97 fps 各一段。不要用未授权的网络视频做仓库内夹具。

**标注**：每 5 帧标一次，镜头切换处逐帧补标。每条记录包含：`frame`、`tUs`、主脸归一化框 `[x,y,w,h]`、主脸是否可见、画面中其他人脸框、备注。建议存为 `experiments/f-0047-reframe/annotations/<clip>.jsonl`。一名标注者完成全部，另一人复核至少 20%；记录不一致处，不强行平均。

**运行**：分析端以 5–10 Hz 采样检测，输出 30 fps CFR；每条素材跑 3 次计时，取中位数和 p95；记录冷启动、CPU 型号、内存、OS、运行时版本、模型哈希。导出端用同一路径计划生成 3 段短片（静止、移动、带剪切），再用 `ffprobe`/播放器核对帧数、时长、音画和字幕。

**指标定义**：

- **主体留框率**：标注主脸框落在裁切框内的面积比例 ≥ 0.9 的采样帧占比。同时报告“主脸中心在框内”的宽松口径，避免只看一个口径。
- **裁切抖动**：输出画幅像素坐标下，裁切中心二阶差分 `c[t] - 2c[t-1] + c[t-2]` 的 RMS，单位 px/frame²；报告 p50/p95/max。另记“0.5 秒内方向反转且幅度 > 4 px”的次数/分钟。
- **错误目标**：主脸可见，但裁切框对另一张人脸的覆盖高于主脸，或框内没有人脸的采样帧占比；按片段和条件分别报告。
- **丢失恢复**：主脸重新出现后，到裁切框重新满足留框口径的时间；报告 p50/p95 和恢复失败次数。
- **耗时/内存**：每秒源视频的分析墙钟时间、CPU 平均/峰值、峰值 RSS、冷启动时间；GPU 可选，不作为首发条件。
- **输出完整性**：输出帧数与 EDL 计算值、时长误差、黑帧/冻结帧、音画同步、字幕安全区；这些是导出验收，不是模型指标。

**建议门槛（待维护者确认，不是已批准值）**：

| 项目 | 建议门槛 | 说明 |
|---|---|---|
| 主体留框率 | 总体 ≥ 95%，每个条件 ≥ 90%，单段不低于 80% | 低于 80% 的片段必须能解释是遮挡/离场还是算法失败 |
| 错误目标 | ≤ 2% 采样帧；单人片段不得切到非主脸 | 多人片段另记，不纳入首发承诺 |
| 抖动 | p95 二阶差分 ≤ 0.5 px/frame²；方向反转 > 4 px 不超过 2 次/分钟 | 1080p 输出坐标；数值需用基线校准 |
| 丢失恢复 | p95 ≤ 1.5 s | 超过保持时间后回中，不突然跳脸 |
| 分析耗时 | ≤ 0.5× 源时长（参考 Mac/Windows 机器） | 先测基线；不达标就降采样或缩输入 |
| 峰值内存 | ≤ 1.0 GB | 不含 FFmpeg 导出进程 |
| 路径边界 | 100% 帧在源画面内 | 任何越界即失败 |
| 预览/导出 | 同一输出帧中心裁切矩形完全一致（整数像素） | 见 Q-4 的一致性检查 |

这些门槛是研究建议，F-0048 的正式验收门槛要由维护者在报告确认时一并确认；未确认前不得写成“已达标”。

## 结论

### Q-1：运行时、模型与许可

#### 运行时对比

包大小来自 2026-11-09 的 PyPI/npm 元数据。`onnxruntime-node` 的数字是整包解包大小，包含多平台二进制；它不是单个安装包的增量。

| 运行时 | 版本/分发 | 许可 | macOS | Windows | 包大小（元数据） | 与现有 Host 的契合 |
|---|---|---|---|---|---|---|
| onnxruntime-node | 1.31.1，npm 原生 addon | MIT | 声明支持 darwin；未真机运行 | 声明支持 win32；未真机运行 | 307.6 MB 解包，43 个文件，含多平台二进制 | 最契合：Host 内直接调用，无 Python |
| onnxruntime（Python） | 1.31.1，PyPI wheel | MIT | 20.9 MB（macOS arm64，cp311） | 14.9 MB（win_amd64，cp311） | 需要 Python 进程 | 与“不打包 Python”冲突 |
| PyTorch | 2.15.0，PyPI wheel | BSD-3-Clause（仓库自动识别为 NOASSERTION，因第三方许可混合） | 138.5 MB（macOS arm64，cp311） | 126.7 MB（win_amd64，cp311） | 还要 torchvision、CUDA 可选件 | Python 侧车，默认排除 |
| MediaPipe（Python） | 1.2.2，PyPI wheel | Apache-2.0 | 39.6 MB（macOS arm64） | 25.3 MB（win_amd64） | 需要 Python 进程；AutoFlip 已退役 | 只能做参考/实验 |
| @mediapipe/tasks-vision | 1.2.2，npm | Apache-2.0 | 浏览器/WASM；未在 Host 验证 | 浏览器/WASM；未在 Host 验证 | 31.3 MB 解包 | 可做浏览器预览实验，不做 Host 推理 |
| onnxruntime-web | 1.31.1，npm | MIT | 浏览器/WASM | 浏览器/WASM | 150.6 MB 解包 | 本轮不需要；预览只消费路径 |

**部署判断**：

- **推荐**：`onnxruntime-node` + 一个 ONNX 人脸检测器，作为 Host 的视觉分析依赖。CPU 优先，GPU 不作为首发要求。它的包很大，但可以按平台裁剪；`pnpm package:host` 目前复制生产依赖，实际安装包增量必须打包后测量（Not run）。
- **不作为默认**：PyTorch/Python 和 MediaPipe Python。它们不满足当前“客户端不打包 Python、Host 不启动 Python”的决定；即使用户自己装 Python，也会把首次使用成本转给普通创作者。
- **不作为默认**：MediaPipe AutoFlip。官方文档明确它是 MediaPipe Legacy Solution，2023-03-01 停止支持，构建要求 Bazel 和 OpenCV 3；这与当前 Node Host、内置 FFmpeg 的打包方式不匹配。
- **Web**：浏览器只负责预览裁切路径，不跑视觉模型；Web 端连远程 Host 时由 Host 分析。这样不需要在浏览器里引入 onnxruntime-web 的 150 MB 包。

#### 代码许可与权重许可

许可证是两道门，不能只看仓库根目录的 LICENSE。

| 资产 | 代码许可 | 权重/模型许可 | 证据与结论 |
|---|---|---|---|
| ONNX Runtime | MIT | 不适用（运行时） | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)，GitHub API 标注 MIT |
| YuNet（OpenCV Zoo） | Apache-2.0（Zoo 根目录） | 模型目录 MIT | [YuNet README](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) 明确“本目录文件 MIT”；适合作为默认候选 |
| InsightFace / buffalo_l | MIT | **仅非商业研究** | [InsightFace README](https://github.com/deepinsight/insightface) 写明代码 MIT，但训练数据和模型仅限非商业研究；buffalo_l 商用需联系授权。默认排除 |
| Ultralytics YOLO（YOLO11/YOLO26 等） | AGPL-3.0 或 Enterprise License | 模型同样受 AGPL/企业许可约束 | [Ultralytics LICENSE](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) 为 AGPL-3.0；README 明确商用需 Enterprise License。**默认拒绝随 FlyCut 分发** |
| yolo-face（FrameShift 的 `yolov11n-face.pt`） | GPL-3.0 | 权重条款未单独核实，且上游基于 Ultralytics | [akanametov/yolo-face](https://github.com/akanametov/yolo-face) 仓库为 GPL-3.0；不能因为 FrameShift 是 MIT 就认为权重可商用 |
| MediaPipe Face Detector / BlazeFace | Apache-2.0（仓库） | 具体 `.tflite` 模型卡需逐个核实 | [MediaPipe LICENSE](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) 为 Apache-2.0；本报告未核对每个模型卡，标“待核实” |
| UNISAL | Apache-2.0 | 预训练权重许可待核实 | [rdroste/unisal](https://github.com/rdroste/unisal) 代码 Apache-2.0；pyautoflip 使用其 saliency，默认不采用 |
| TalkNet-ASD | MIT | 预训练权重条款待核实 | [TaoRuijie/TalkNet-ASD](https://github.com/TaoRuijie/TalkNet-ASD)，2023-10-23 最后推送 |
| LoCoNet | 官方仓库未检测到许可；第三方 fork 为 MIT | 权重条款待核实 | [SJTUwxz/LoCoNet_ASD](https://github.com/SJTUwxz/LoCoNet_ASD) 无许可证；[DongKeon/LoCoNet-ASD](https://github.com/DongKeon/LoCoNet-ASD) 为 MIT。默认不采用 |
| AVA-ActiveSpeaker | 数据集/标注许可待核实 | 视频来自 YouTube，需逐条核对 | [arXiv:1901.01342](https://arxiv.org/abs/1901.01342)；只用于研究/评测，不进入发行包 |

**结论**：默认发行栈只接受 ONNX Runtime（MIT）+ YuNet（MIT）这一类的组合。若 YuNet 在侧脸/遮挡上不达标，下一步评估 MediaPipe Face Detector 的模型卡或采购可商用的检测权重；**不得**因为“效果更好”而回退到 InsightFace buffalo_l 或 Ultralytics YOLO。若未来购买 Ultralytics Enterprise License，必须单独做许可评审，不能只换一个模型文件名。

#### 推荐的最小选型

1. Host 侧用 `onnxruntime-node` 加载 ONNX 检测器，输入缩放到 640 左右的短边，5–10 Hz 采样；CPU 执行。
2. 默认检测器先用 YuNet；它的模型目录许可是 MIT，适合随包分发或首次下载。
3. 人脸框只作为“主体候选”，跟踪、粘性选择、平滑、回退都在 `shared/` 的纯 TypeScript 里做，模型可替换。
4. 模型文件单独记录 `id/version/sha256/license`；下载失败、校验失败或许可未确认时，明确回退居中，不静默换模型。
5. 不在本轮引入人脸识别/身份识别；只做检测和跟踪，避免额外的隐私和许可面。

### Q-2：真实单人口播的评测

本报告没有运行真实视频，无法给出留框率、抖动、错误目标、耗时或内存的数值。可复现协议见「实验 / Q-2 真实视频评测协议」，建议门槛也在那里，均待维护者确认。

能给出的判断只有方法层面：

- 只用“平均留框率”不够。移动、短暂离场、遮挡、侧脸要分开报告，否则静止片段会掩盖失败。
- 抖动必须用输出像素坐标定义，否则 1080p 和 720p 的数字不可比。
- 错误目标要人工标注“主脸”，不能只看检测置信度；单人口播里出现第二张脸时，算法不应自动切过去。
- 计时必须区分冷启动、分析、导出；安装包大不等于运行时内存大，反之亦然。
- 任何截图、样例和日志都要用授权素材；报告不包含未授权视频或模型 token。

在这套协议跑完之前，F-0048 不应宣称“主体跟随可用”，只能做居中裁切或明确的实验入口。

### Q-3：丢失、多人、镜头切换与平滑

#### 状态机

建议把单人路径做成一个显式状态机，状态写入 `CropPath` 的关键帧，预览和导出都能看到为什么回中。

| 状态 | 触发 | 行为 | 备注 |
|---|---|---|---|
| `tracking` | 主脸可见，且与当前目标连续 | 跟随主脸中心，平滑更新 | 正常路径 |
| `holding` | 主脸短暂丢失（遮挡、侧脸、检测抖动） | 保持最后的裁切位置，不重新选目标 | 建议 1.5 s 起始值；algometrix 用 2.0 s |
| `recentering` | 丢失超过保持时间，或开场没有主脸 | 在 0.5–0.8 s 内缓动到居中/固定构图 | 不瞬移；回中后保持 |
| `ambiguous` | 两张脸分数/面积接近，或新脸持续挑战当前目标 | 冻结当前目标，界面标“多人/主体不明确” | 不自动按说话人切换 |
| `scene-cut` | 检测到镜头切换，或 EDL 拼接边界 | 重置平滑器，吸附到新镜头首个稳定目标；没有目标就回中 | 镜头切换的硬切是预期，不是抖动 |
| `stale` | EDL/源尺寸/时长/帧率变化 | 旧路径失效，回中或要求重新分析 | 与 F-0048 AC-4 对齐 |

#### 目标选择

- 以人脸面积、检测置信度、与上一帧的 IoU/中心距离、与当前裁切中心的距离做加权；当前目标有粘性。
- 新候选必须在连续若干帧（建议 3–5 帧）稳定，并且分数超过当前目标一个余量（建议 20%），才允许切换。
- 单人口播里，第二张脸出现但当前主脸仍在：保持当前目标，不因一帧的最高分换人。
- 当前主脸消失超过保持时间，且新候选稳定：可以切到新候选；如果新候选不稳定，回中。
- 多人且无法判断主次：冻结或回中，界面提供手动选择；**本轮不做按说话人自动切换**。

#### 平滑与边界

- 建议用 one-euro 或临界阻尼平滑，离线分析可以用前后向平滑；因为路径在分析后生成，预览不需要因果滤波器。
- 速度上限建议 1 个裁切宽度/秒；加速度上限单独设，避免“速度没超但突然折返”。
- refocus band 建议 3% 画面宽度：主脸在当前裁切中心附近小幅晃动时不重新瞄准。
- 裁切矩形始终夹在源画面内；靠近边缘时平移裁切框，不把人脸切掉。
- 裁切宽高取偶数像素，满足 yuv420；宽高比偏差用 `scale` 补齐，不改变路径语义。
- 镜头切换和 EDL 拼接处允许硬切；镜头内不允许瞬移。

#### 推近推远

首发建议固定裁切高度，只做水平/垂直平移；推近推远作为可选能力，默认关闭。若开启：

- 用主脸面积的变化做迟滞，进入/退出门槛不同，避免在阈值附近来回缩放。
- 缩放速度单独限幅，建议不超过 0.2×/秒；缩放和 pan 同时发生时优先保证主体留框。
- 最大推近建议 1.5×，不要为了填满画面把脸放大到失真。
- 缩放同样写入 `CropPath` 的 `w/h` 关键帧，预览和导出共用；不能预览一套、导出另一套。

#### 多人能力的边界

本轮只做“单人主目标 + 多人歧义时回退/手动选择”。按说话人切换需要音频-视觉主动说话人检测（TalkNet-ASD、LoCoNet 一类）和说话人分离，双人分屏还需要额外的布局与渲染；这些是 E-07 后续候选，不进入 F-0048 的实现承诺。pyautoflip 的分屏和 saliency 可以作为未来参考，但其 InsightFace/UNISAL 许可和 Python 运行时不能直接搬进默认栈。

### Q-4：预览与 FFmpeg 导出的同一路径

#### 现有契约

当前项目的统一编辑决策在 [`shared/editing/edl/index.ts`](../../../shared/editing/edl/index.ts)：EDL 使用整数微秒，`deriveKept` 给出源区间到输出区间的映射，`outputToSource`/`sourceToOutput` 是现成的双向映射；`ffmpegVideoFilter` 已经把保留区间映射到一条输出时钟，再用 `fps=fps=source_fps` 统一帧率。导出插件 [`server/plugins/export.ts`](../../../server/plugins/export.ts) 先做 EDL 选择/拼接，再叠加字幕带。裁切必须插在“EDL 映射之后、字幕叠加之前”，否则字幕会跟着人脸漂移。

#### 建议的 `CropPath`

路径以**源媒体时间**为主时钟，矩形用源画面的归一化坐标；这样源视频换分辨率时不用重算语义，预览和导出也能共用。

```json
{
  "version": 1,
  "source": {
    "width": 1920,
    "height": 1080,
    "durationUs": 60000000,
    "frameRate": { "num": 30000, "den": 1001 }
  },
  "edl": {
    "sourceDurationUs": 60000000,
    "fingerprint": "sha256:..."
  },
  "output": { "width": 1080, "height": 1920, "aspect": "9:16" },
  "mode": "face-follow",
  "params": {
    "holdMs": 1500,
    "recenterMs": 600,
    "maxSpeedCropWidthsPerSec": 1.0,
    "refocusBandRatio": 0.03,
    "zoom": { "enabled": false, "min": 1.0, "max": 1.5 }
  },
  "model": { "id": "yunet", "version": "2023mar", "license": "MIT" },
  "keyframes": [
    { "tUs": 0, "x": 0.5, "y": 0.5, "w": 0.3164, "h": 1.0, "state": "center" },
    { "tUs": 500000, "x": 0.52, "y": 0.5, "w": 0.3164, "h": 1.0, "state": "tracking" }
  ],
  "createdAt": "2026-11-09T00:00:00Z"
}
```

字段约定：

- `x/y` 是裁切中心，`w/h` 是裁切宽高，全部相对源画面归一化到 `[0,1]`。
- `tUs` 是源媒体整数微秒；关键帧按时间严格递增，首帧覆盖 0，末帧覆盖 `source.durationUs`。
- `edl.fingerprint` 是规范化 EDL（版本、源时长、deleted 区间）的哈希；EDL 或源尺寸/时长/帧率变化都必须使路径失效。
- `model` 记录实际使用的模型和版本；换模型不自动沿用旧路径。
- `state` 用于预览调试和导出审计，不参与像素计算。

如果不想把 `CropPath` 写进项目格式，也可以先作为视频级派生资产保存；但“重开项目还能复用路径”要求它随项目持久化。新增项目字段属于格式变化，必须先写 ADR，不能在设计阶段顺手加。

#### 时间与帧映射

建议所有输出帧用整数帧号 `n` 计算，避免浮点累计误差：

```text
tOut = (n + 0.5) / fps
tSrc = outputToSource(edl, tOut)
rect = evaluateCropPath(path, tSrc)
```

- 用帧中心而不是帧起点，避免落在 EDL 边界上时选错保留段。
- `outputToSource` 在最后一段末尾返回最后一个源时间；导出最后一帧仍应被 `trim` 覆盖，需要夹具验证。
- 帧率必须保存为有理数（例如 30000/1001），不能只存 `29.97`。当前 [`server/plugins/export.ts`](../../../server/plugins/export.ts) 的 `probeVideo` 用正则读十进制 fps，`ffmpegVideoFilter` 用 `fps=source_fps`；长片在 29.97 下可能累计偏差，建议在实现前把探测结果转成有理数并写入路径/导出计划。
- EDL 的删除区间在源时间上可能跨过路径关键帧；导出只评估保留区间，拼接处允许硬切，不跨删除区间插值。

#### 预览与导出如何共用

1. **纯函数**：在 `shared/` 放 `evaluateCropPath(path, sourceTimeUs)`、`toPixelRect(rect, width, height)`、`buildCropSchedule(path, edl, fps, frameCount)`。预览和 Host 都调用同一份代码。
2. **浏览器预览**：播放器当前时间先映射到源时间，求值后把源矩形画到输出 canvas；不要用 CSS 百分比近似，否则和 FFmpeg 的整数裁切对不上。
3. **Host 导出**：`ffmpegVideoFilter(edl)` 产出 `[vout]` 后，插入 `crop`；裁切参数由 `buildCropSchedule` 生成。字幕叠加仍用现有 output canvas，不跟随人脸。
4. **裁切命令**：优先验证 FFmpeg `crop` 的 `x/y/w/h` 定时命令 + `sendcmd`，按输出帧时间下发；具体命令语法和当前内置 FFmpeg 版本是否支持，必须做最小夹具（Not run）。如果不支持，退化为由同一 schedule 生成的分段线性 `crop` 表达式，不允许预览和导出各写一套插值。
5. **偶数尺寸**：`toPixelRect` 统一取偶数宽高并夹在画面内；预览用同一整数矩形，导出不另行四舍五入。

#### 一致性检查

建议在实现阶段做下面几层检查；本报告没有运行：

1. **Schema/边界**：路径版本、关键帧单调、`w/h > 0`、矩形在 `[0,1]`、输出宽高比正确、EDL 指纹匹配。
2. **纯函数对拍**：对 1000 个确定性时间点，预览求值器与导出 schedule 的整数矩形完全相等；不等即失败。
3. **FFmpeg 夹具**：3 段短片（静止、横移、带 EDL 剪切），25/30/29.97 fps 各一遍；用无损中间格式抽帧，把实际裁切矩形与 schedule 对照，检查越界、黑帧、帧数。
4. **端到端**：导出时长/帧数与 `outputDuration(edl)` 一致（建议容差 1 帧）；音画同步；字幕位置不随人脸移动；原片和既有项目不变。
5. **失效**：改 EDL、换源、改源时长/尺寸/帧率后，旧路径必须被标 stale；不能静默套用。

**“两端抽帧一致性是否可达”**：设计上可达，因为两端消费同一份 `CropPath` 和同一套 `outputToSource`/整数取整；但没有实测。主要风险是 FFmpeg 定时命令的帧边界、29.97 的有理数时钟、浏览器 `currentTime` 精度和 yuv420 偶数尺寸。先用夹具证明，再谈“一致”。

### Q-5：ADR、支持矩阵与落地门槛

#### 建议 ADR

建议至少写一篇 ADR；如果 `CropPath` 要进入项目存储格式，建议拆成两篇，避免运行时候选和持久化契约互相绑死：

- **ADR-0007：本地视觉推理运行时与模型许可门槛。** 决定 Host 使用 `onnxruntime-node`（CPU 优先）；默认模型必须代码/权重都可商用；不打包 Python；不默认引入 AGPL Ultralytics 或非商业 InsightFace 权重；模型替换必须重新过许可与质量门槛。
- **ADR-0008：`CropPath` 路径契约、EDL 指纹与预览/导出共用。** 决定归一化矩形、源时间关键帧、有理数帧率、EDL 指纹、失效规则、逐帧 schedule 和 FFmpeg crop 的接入位置；明确项目格式版本变化和迁移。

两篇都应是 `proposed`，由维护者在确认本报告时一并决定；本报告不创建 ADR，也不修改 [decisions.md](../../decisions.md)。如果维护者希望只写一篇，可以把两篇合并为“运行时与路径数据”，但不能把路径格式留到实现时即兴决定。

#### 建议支持矩阵

这是待实测的目标矩阵，不是已支持声明：

| 平台/形态 | 分析 | 预览 | 导出 | 状态 |
|---|---|---|---|---|
| macOS 14+ Apple Silicon | onnxruntime-node CPU | 浏览器 canvas | Host FFmpeg | 首要目标；Not run |
| macOS Intel | onnxruntime-node CPU | 浏览器 canvas | Host FFmpeg | 次要目标；Not run |
| Windows 10/11 x64 | onnxruntime-node CPU | 浏览器 canvas | Host FFmpeg | 首要目标；Not run |
| Windows arm64 | 暂不支持 | 预览可看 | 导出可走 Host | 不在首发矩阵 |
| Linux Host / Cloud | 可选 | 浏览器 canvas | Host FFmpeg | 后续；Not run |
| Web 客户端 | 由远程 Host 分析 | 同一路径 | 远程 Host | 预览不跑模型 |
| GPU | 可选 | 不适用 | 不适用 | 不作为首发要求 |

#### 落地验收门槛

在 Q-2 建议值之外，F-0048 还应满足：

- **许可**：发行包内所有代码和权重都在允许清单；附 NOTICE/第三方许可；没有 AGPL/GPL/非商业权重。模型哈希固定，首次下载失败可重试并明确报错。
- **行为**：单人主目标可见时留框率达到门槛；丢失时保持或平滑回中；多人歧义不自动换人；所有路径在源画面内；镜头切换/EDL 拼接不产生镜头内瞬移。
- **一致性**：预览与导出同一输出帧的整数裁切矩形一致；EDL 指纹不匹配时阻止导出并要求重新分析；导出帧数/时长在 1 帧容差内；字幕不随人脸漂移。
- **资源**：在参考 Mac 和 Windows 机器上记录分析耗时、峰值 RSS、冷启动和安装包增量；达到 Q-2 建议值后再由维护者确认正式数值。
- **体验**：无模型/无资源/多人/路径过期都有明确状态；可以取消；失败不产生半成品；原片不被覆盖。

#### 只记录、不承诺的后续能力

- 多人按说话人自动切换：需要音频-视觉 ASD（TalkNet-ASD、LoCoNet 等）与说话人分离；版权、模型许可和延迟都未评估。
- 双人分屏：需要额外布局、两个裁切路径和渲染；pyautoflip 只能作为参考。
- 自动推近推远、saliency 混合、人脸识别：不进入 F-0048 首发范围。

## 对后续需求的影响

- **F-0048（主体跟随预览与导出）**：可以在本报告确认后进入设计和实现，但首发范围应收敛为“单人主目标 + 丢失回中/保持 + 多人歧义手动选择或回中”。不要在本需求里承诺自动说话人切换或分屏。
- **F-0046（居中裁切竖屏导出）**：不受影响；继续作为没有模型/没有分析时的明确回退，不把居中裁切宣传成智能构图。
- **F-0049（批量短片导出）**：可以复用同一 `CropPath` 和导出 schedule；批量场景要先确认路径持久化和失效规则，避免每条短片各算一套。
- **E-07 候选**：多人说话人切换、双人分屏仍留在后续候选；本报告不新增需求编号，也不改 Epic 的优先级。
- **运行时**：如果维护者不接受 `onnxruntime-node` 的包体积，替代方案应是“不默认提供主体跟随”，而不是回退到 Python 或 AGPL 模型。

## 来源

全部访问日期均为 2026-11-09。GitHub API 的 `pushed_at` 只表示仓库最近推送，不等于发布版本。

| 来源 | 用途 |
|---|---|
| https://github.com/algometrix/vertical_video_convertor | 仓库、README、算法参数、MIT 许可、buffalo_l 280 MB 说明 |
| https://github.com/fralapo/FrameShift | 仓库、README、每镜头固定裁切、YOLO face/MediaPipe fallback、MIT 许可 |
| https://github.com/AhmedHisham1/pyautoflip | 仓库、README、pyproject、UNISAL/InsightFace/MediaPipe、MIT 许可 |
| https://github.com/KazKozDev/auto-vertical-reframe | 仓库、README、依赖、macOS tested/Windows untested、MIT 许可 |
| https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/autoflip.md | AutoFlip legacy、2023-03-01 停止支持、OpenCV 3/Bazel |
| https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/examples/desktop/autoflip/README.md | AutoFlip 构建/运行方式 |
| https://github.com/deepinsight/insightface | 代码 MIT、模型/训练数据非商业研究、buffalo_l 商用联系 |
| https://github.com/ultralytics/ultralytics/blob/main/LICENSE | AGPL-3.0 原文 |
| https://github.com/ultralytics/ultralytics | README 的 AGPL/Enterprise License 说明 |
| https://github.com/akanametov/yolo-face | FrameShift 默认 face 权重来源；仓库 GPL-3.0 |
| https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet | YuNet 模型目录 MIT、模型说明 |
| https://github.com/rdroste/unisal | UNISAL 代码 Apache-2.0；权重许可待核实 |
| https://github.com/microsoft/onnxruntime | ONNX Runtime MIT |
| https://www.npmjs.com/package/onnxruntime-node | 1.31.1 包元数据、307.6 MB 解包、darwin/win32/linux |
| https://pypi.org/project/onnxruntime/ | 1.31.1 wheel 大小 |
| https://pypi.org/project/torch/ | 2.15.0 wheel 大小 |
| https://pypi.org/project/mediapipe/ | 1.2.2 wheel 大小 |
| https://pypi.org/project/ultralytics/ | Ultralytics 包版本 |
| https://www.npmjs.com/package/@mediapipe/tasks-vision | 1.2.2 包元数据、31.3 MB 解包 |
| https://www.npmjs.com/package/onnxruntime-web | 1.31.1 包元数据、150.6 MB 解包 |
| https://arxiv.org/abs/1901.01342 | AVA-ActiveSpeaker 论文（2019-01-05） |
| https://arxiv.org/abs/2107.06592 | TalkNet-ASD 论文（2021-07-14） |
| https://arxiv.org/abs/2301.08237 | LoCoNet 论文（2023-01-19） |
| https://ai.googleblog.com/2020/02/autoflip-open-source-framework-for.html | AutoFlip 官方介绍（由 MediaPipe 文档引用） |

## 待核实与重评条件

下面这些不是“已核实”，在实现/验收前必须补：

- MediaPipe Face Detector、UNISAL、TalkNet-ASD、LoCoNet、AVA-ActiveSpeaker 的具体权重/标注许可；本报告只核实了代码仓库许可或论文页面。
- `onnxruntime-node` 在 macOS arm64、macOS x64、Windows x64 的真实安装、运行和安装包增量；npm 元数据不等于真机通过。
- YuNet 在侧脸、遮挡、低光、1080p 小人脸下的留框率；没有真实视频数据。
- FFmpeg `crop` 的 `sendcmd` 定时命令在当前内置版本是否可用；不可用时的分段表达式方案。
- 29.97/25/30 fps 下的帧数、边界和预览/导出像素一致性。
- 真实标注视频的留框率、抖动、错误目标、耗时和内存；全部 Not run。
- 安装包体积和 Windows 签名/分发影响；本报告只有包元数据。

重评触发条件：更换检测模型或权重、改变 EDL/项目存储格式、改变输出帧率策略、把分析移到浏览器/云端、或 F-0048 实测不达标。任何一项发生，都要回到本报告的 Q-1/Q-4 重新核实。
