# Computer 测试矩阵

任务状态以 [唯一任务记录](../../tasks/2026-09-18-computer-native-implementation-task.md) 为准。本矩阵记录验证范围，不把测试文件存在等同于测试通过。

## 最终 P00–P08 验证矩阵

下列为最终资格摘要；后面的逐阶段命令和旧场景矩阵均为历史记录，不能覆盖本节或唯一任务记录。证据根为 `.artifacts/computer/`。

| 方案场景 | 最终证据 | 范围/限制 |
| --- | --- | --- |
| T01 默认coding；T04版本/架构；T21独立安装 | p07安装/模式验证；p08/delivery-verification.json | 仓库外解压及独立offline npm ci、CLI、真实read/faux、惰性factory和真实no-host加载均通过；Bun失败明确不支持 |
| T02转换/注册/snapshot；T03 single-flight | test/computer；p07/delivery-final-check | 204pass/5skip宿主回归；首次失败缓存，不假称半owner全局无泄漏 |
| T05响应/Stop | p02-live原生pending pong；p07实际TUI模式 | IPC Stop和TUI正常关闭有证据；未声称物理Stop点击 |
| T06队列取消；T07 preabort；T08祖先撤权 | 原生barrier；p08/final-gui-verification.json | 100pre-cancel+100ancestor-revoke，301terminal、零input、C236；非通用post-dispatch延迟保证 |
| T09 replacement；T10互斥；T11未知终态 | lifecycle/runtime-owner/host回归；P03实际争用；P07 native child | 旧闭包不可复活、未知保留lease；driver-owned drain不等于外部效果完成 |
| T12批段；T13 stale/布局；T14 partial/unknown | p06-trim最终AX/browser/pixel资格；p08配对form | 30pairs/60arms均成功，600terminal/120自然退出；失败/未知不重放 |
| T15 late-window/focus | P04/P05对抗与差分；P08每arm独立focus/geometry oracle | 保留保守焦点等待，无不受限快路径声明 |
| T16缺失观察；T17图像/DPI | P06 bounded view/grant及1×/2×像素oracle；P07实际vision click | 只授予实际可见refs；裁剪/遗漏不当全局不存在；13键中仅Tab/Return实送达 |
| T18真实feature裁剪 | p06-trim/final-verification.json | active depfile/双profile证明、55包/version排除、22976672B；不是只取消注册 |
| T19 browser profile | P04/P06全部13case；p08/installed-browser-live-run | 实际安装AgentSession DOM八步、4terminal/9page events、C237及目录清理；不支持个人profile/subframe/trusted keyboard |
| T20上下文/压缩 | p08/final-context.log | 7个真实AgentSession/faux测试，实际compaction checkpoint、provider/估算同view、不可见图像grant失效 |
| T22关闭/崩溃/buffer | 原生lease/Drop回归、P06 buffer scope实验、P08自然关闭 | 测试buffer在native close后存活、consumer释放后GC；旧未知终态保留，不声明全局无泄漏 |

最终命令：`python3 .artifacts/computer/p07/check-current.py delivery-final-check`：完整check0（1420文件无修复）、204pass/5skip、controller38pass、source drift0。P08 `final-native-types`实际生成边界和root graph双层检查均0；`final-context`上述7项通过；`final-native-tests`为21项desktop加2项基本packager通过、6项需单独材料环境的packager测试skip（P07独立packager资格8/8保持）。精确argv/cwd/exit在P08同名command.json。

最近完整构建/无密钥全套：p07/phase-final-check，offline build0、check0、`./test.sh`1；test-comparison.json确认仍为P03同名九失败、无新增/消失，不声称全仓绿灯。P08两测量contract及raw/verifier见[benchmark-summary](benchmark-summary.md)。交付迁移初版的Python3.9 extraction-filter错误和npm同一路径双config错误均保留，修正测试助手后v3完整通过，未改产品或复跑GUI。

## P00 实际命令

`ROOT=/Users/w/Projects/easy-pi/pi`；`SNAP=$ROOT/.artifacts/computer/p00/workspace`；`ISO=$ROOT/.artifacts/computer/run-isolated.sh`。这些是本轮实际存在的本地目录，不是新增产品脚本。重跑前重新校准工作树与材料；不要用旧快照结果声称新代码通过。

| ID | cwd | 命令 | exit | 证据（ROOT 相对） |
| --- | --- | --- | --- | --- |
| B01 | SNAP | `bash "$ISO" npm run build:offline` | 0 | `.artifacts/computer/p00/build-offline.log` |
| B02 | SNAP | `./test.sh` | 1 | `.artifacts/computer/p00/test-sh.log`，27 个已有失败 |
| B03 | SNAP/packages/coding-agent | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-tool-gateway.test.ts test/suite/agent-session-runtime.test.ts` | 0 | `.artifacts/computer/p00/faux-session.log`，13/13 |
| B04 | SNAP | `bash "$ISO" npm run check` | 2 | `.artifacts/computer/p00/check.log`，1 个已有 TS2339；后续 browser smoke 未运行 |
| N01 | /Users/w/Projects/easy-pi/cua/libs/cua-driver/rust | `cargo metadata --locked --offline --format-version 1` | 101 | `.artifacts/computer/p00/cargo-metadata.log`，缺 jsonschema |
| N02 | 同 N01 | `cargo tree --locked --offline -e features -p cua-driver-sdk --target aarch64-apple-darwin` | 101 | `.artifacts/computer/p00/cargo-tree.log`，缺 jsonschema |

命令输出完整保留并附 `.exit`。B02 使用原有 test.sh 隔离 HOME 和环境；B03 显式复用隔离助手，而非向 test.sh 传不存在的参数。未运行任何真实 provider、GUI、绑定生成或 native 初始化。

## P01 实际命令

沿用上述 `ROOT` / `ISO`；`P1=$ROOT/.artifacts/computer/p01/workspace`。P1 是 **P00 副本加仅本任务 9 个源码/测试文件**，不混入其他并发修改；P00 check 的两处格式化保留在副本内。`verified-source-manifest.json` 校验最终源码与 P1 一致，`final-drift.json` 证明 P1 tracked 差异仅两处 wrapper 文件，P00 未再变化。

| ID | cwd | 命令 | exit | 证据（ROOT 相对） |
| --- | --- | --- | --- | --- |
| C01 | ROOT/packages/coding-agent | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/computer/service.test.ts` | 0 | `.artifacts/computer/p01/service-verified.log`，17/17 |
| C02 | 同 C01 | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/computer/tool-definition.test.ts` | 0 | `.artifacts/computer/p01/wrapper-final.log`，类型 fixture 修正后 7/7 |
| C03 | 同 C01 | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/computer/integration.test.ts` | 0 | `.artifacts/computer/p01/integration.log`，8/8 |
| C04 | 同 C01 | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/computer test/agent-session-dynamic-tools.test.ts test/extensions-runner.test.ts test/pi-child-session-host.test.ts test/pi-collaboration-tools.test.ts test/suite/agent-session-tool-gateway.test.ts test/suite/agent-session-runtime.test.ts test/suite/agent-session-queue.test.ts test/suite/agent-session-compaction.test.ts` | 0 | `.artifacts/computer/p01/targeted-regressions.log`，11 文件 / 176 测试 |
| C05 | P1 | `bash "$ISO" npm run check` | 2 | `.artifacts/computer/p01/check.log`，仅 P00 已有 TS2339；无自动修改；browser smoke 未运行 |
| C06 | P1 | `bash "$ISO" npm run build:offline` | 0 | `.artifacts/computer/p01/build-offline.log` |
| C07 | P1 | `./test.sh` | 1 | `.artifacts/computer/p01/test-sh.log`；仍是 P00 的 27 个失败 |
| C08 | ROOT | `node node_modules/@biomejs/biome/bin/biome check --error-on-warnings packages/coding-agent/src/core/extensions/types.ts packages/coding-agent/src/core/tools/tool-definition-wrapper.ts packages/coding-agent/src/core/computer/contracts.ts packages/coding-agent/src/core/computer/service.ts packages/coding-agent/src/core/computer/tool.ts packages/coding-agent/test/computer/tool-definition.test.ts packages/coding-agent/test/computer/service.test.ts packages/coding-agent/test/computer/fake-backend.ts packages/coding-agent/test/computer/integration.test.ts` | 0 | `.artifacts/computer/p01/biome-final.log`，9 文件，无写入 |

初次 C05 发现本任务 wrapper fixture 的 TS2322/TS2352，记录于 `check-initial.log`，exit 2；修正后 C02 与 C05 重跑。未删测试、未降低行为断言，未修复无关基线错误。C04 先于该纯类型 fixture 修正；最终 C07 和独立审查均覆盖修正后的全部 32 个 Computer 测试。

`test-comparison.json` 比较 P00/P01 完整失败名称，新增/消失失败集合均为空；coding-agent 从 2319 passed 增至 **2351 passed**，仍 23 failed / 56 skipped。其余 workspace 结果不变，ai 仍 4 failed；这只证明此次受控运行无新增失败，不是全仓通过或消除 flaky 风险。独立审查的范围、命令、32/32 exit 0 与固定文件 hash 在 `review.md`。

## P02 受控编译与最新基线实际命令

`A=$ROOT/.artifacts/computer/p02`；`D=$A/upstream/libs/cua-driver`；`P2=$A/current-baseline/workspace`。本轮实际环境入口 `ENV=/tmp/computer-p02-env.sh`，结束后原样归档到 `$A/repro/computer-p02-env.sh`。它固定项目 Rust 1.97.1、默认 `CARGO_NET_OFFLINE=true`，不继承凭据/loader hooks。只在 dependency hydration 命令显式允许网络；不是 OS sandbox。

| ID | cwd | 实际命令 | exit | 证据（A 相对） |
| --- | --- | --- | --- | --- |
| D01 | ROOT | `bash "$ENV" /Users/w/.cargo/bin/rustup toolchain install 1.97.1 --profile minimal --component rustfmt --no-self-update` | 0 | `rustup-install.log`；`toolchain-verified.log` 复核版本 |
| D02 | A/npm | `bash "$ENV" npm install --package-lock-only --ignore-scripts --omit=optional`，随后 `bash "$ENV" npm ci --ignore-scripts --omit=optional --offline` | 0 / 0 | `npm-lock.log`、`npm-ci.log`；只装三个 exact pins |
| D03 | D/rust | `bash "$ENV" env CARGO_NET_OFFLINE=false /Users/w/.cargo/bin/rustup run 1.97.1 cargo fetch --locked --target aarch64-apple-darwin` | 0 | `cargo-fetch.log`；仅 Mac 缓存尚不足以运行无过滤 metadata |
| D04 | D/rust | `bash "$ENV" /Users/w/.cargo/bin/rustup run 1.97.1 cargo metadata --locked --offline --filter-platform aarch64-apple-darwin --format-version 1` | 0 | `cargo-metadata.json` / `.log` |
| D05 | D/rust | `bash "$ENV" /Users/w/.cargo/bin/rustup run 1.97.1 cargo tree --locked --offline -e features -p cua-driver-sdk --target aarch64-apple-darwin` | 0 | `cargo-tree.log` |
| D06 | D/rust | `bash "$ENV" /Users/w/.cargo/bin/rustup run 1.97.1 cargo build --locked --offline --release -p cua-driver-sdk` | 0 | `sdk-build.log`，arm64 SDK 编译 |
| D07 | D/rust | `bash "$ENV" node ../scripts/generate-uniffi-bindings.mjs --check` | 1 | `bindings-check.log`；嵌套 unfiltered metadata 缺 aes 0.8.4，不是生成内容不一致 |
| D08 | D/rust | `bash "$ENV" env CARGO_NET_OFFLINE=false /Users/w/.cargo/bin/rustup run 1.97.1 cargo fetch --locked` | 0 | `cargo-fetch-all.log`；原锁 hash 不变 |
| D09 | D/rust | `bash "$ENV" /Users/w/.cargo/bin/rustup run 1.97.1 cargo metadata --locked --offline --format-version 1` | 0 | `cargo-metadata-all.json` / `.log` |
| D10 | D/rust | 重跑 D07 原命令 | 0 | `bindings-check-retry.log`；Python/TS generated 均一致 |
| D11 | D/rust | `bash "$ENV" node ../scripts/stage-uniffi-library.mjs` | 0 | `stage-native.log`；guarded locked/offline copy-mode N-API 编译并复制 SDK，无加载 |
| D12 | D/rust | `bash "$ENV" /Users/w/.cargo/bin/rustup run 1.97.1 cargo run --locked --offline -p cua-driver-bindgen --bin cua-driver-abi-header -- --check` | 0 | `header-check.log`，无 driver |
| D13 | D/typescript | `bash "$ENV" node "$ROOT/node_modules/typescript/bin/tsc" --target ES2022 --module NodeNext --moduleResolution NodeNext --declaration --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --types node --typeRoots "$ROOT/node_modules/@types" --rootDir src --outDir dist src/index.ts` | 0 | `typescript-emit.log`；仅编译 root/native graph，不 import 输出，不编译 Electron/Fleet |
| D14 | ROOT | `python3 /tmp/computer-p02-verify.py`（归档于 repro/） | 0 | `verification.json` / `.log`，570 inputs、三 npm 来源文件、四锁、产物和主树边界 |
| B05 | P2 | `bash "$ISO" npm run build:offline` | 0 | `current-baseline/build-offline.log` |
| B06 | P2 | `bash "$ISO" npm run check` | 0 | `current-baseline/check.log`；coordinator 原命令重跑 `current-check-verified.log` 也是 0 |
| B07 | P2 | `./test.sh` | 1 | `current-baseline/test-sh.log`；10 失败 / 7 文件，无 Computer 失败 |
| B08 | P2/packages/coding-agent | `bash "$ISO" node ../../node_modules/vitest/dist/cli.js --run test/footer-data-provider.test.ts` | 0 | `footer-recheck.log`，8/8；没有诊断 B07 的超时原因 |

UBRN 和 adapter 的独立锁准备及 feature tree 命令完整保留于 `ubrn-{lock,fetch,tree}.log`、`runtime-{lock,fetch,tree}.log`，均 exit 0；安全补丁为 `build-guards.patch`。D10 内部 metadata 继承 offline 但不显式 locked，已验证前后各锁 hash 不变。原脚本与 tarball 的生成/Rust 代码未被手写替换。

静态检查实际运行 `file`、`otool -L/-l`、`nm -gU`、SHA256；输出 `sdk-artifact.log`、`sdk-mach-o.log`、`sdk-symbols.log`、`native-artifacts.log`、`runtime-mach-o.log`、`runtime-symbols.log`。确认两产物 arm64、109 checksum 符号存在，**不代表 checksum 函数被执行、native ABI/load 或退出行为通过**。

B05—B07 使用最新脏主树独立快照，不是 P00 加 overlay。旧 TS2339 已不复现；全套仍有 ai 4 / coding-agent 6 个失败，与 P01 共享 9 个 failure identities、18 个旧项消失、1 个新观察到的 footer timeout。测试定义也有变化，不能把消失项全部报成已修复。精确清单、源码/material hashes、无回写证明见 `current-baseline/report.md`。本轮没有修复这些无关失败。

## P02 本轮无 GUI 接通实际命令

`E=$ROOT/.artifacts/computer/p02-connect`；`NODE=/Users/w/.local/share/fnm/node-versions/v24.15.0/installation/bin/node`；`SDK=$D/typescript`。本轮`/tmp/computer-p02-probe-runner.py`调用已归档P02环境helper，默认注入`ALLOW_NATIVE_LOAD_TESTS=true`，GUI/REAL_APIS=false；30秒诊断进程上限不是原生取消。完整命令、cwd、实际exit、elapsed、timedOut见E各`*-command.json`，原始输出和失败均保留。

| ID | 被runner执行的命令/入口 | exit | E内证据与范围 |
| --- | --- | --- | --- |
| L01 | `node /tmp/computer-p02-import-no-gui.mjs`，随后换上述绝对NODE | 127 / 0 | `upstream-import*`；首次PATH不含Node，重试真实SDK import及自然退出，没有driver |
| L02 | `/usr/bin/python3 /tmp/computer-p02-abi-no-gui.py` | 0 | `abi-scalars*`；C ABI1.1.0兼容/空输出、UniFFI30、109 checksum值 |
| L03 | `$NODE $ROOT/native/computer/scripts/probe-load.mjs $SDK` | 0 | `pinned-loader*`与后增codec的`pinned-codecs*`；新loader真实加载/自然退出，生成codec精度与未确认effect，无driver |
| L04 | `$NODE $ROOT/native/computer/scripts/typecheck.mjs $SDK` | 2 / 0 | `adapter-types*`；初次pins键冲突/两fixture索引错误修正后strict检查通过；含probe的checkJs，无native import |
| L05 | `env ALLOW_NATIVE_LOAD_TESTS=false $NODE --test $ROOT/native/computer/test/*.test.ts` | 0 | `native-contracts*`；26 passed，1 native opt-in skipped；含19 adapter + 7 integrity/loader测试 |
| L06 | `env CUA_DRIVER_TYPESCRIPT_DIR=$SDK $NODE --test $ROOT/native/computer/test/native-load.test.ts` | 0 | `native-load-test*`；独立最小环境child加载+codec+event-loop turn+自然退出，1/1 |
| L07 | `$NODE $ROOT/node_modules/@biomejs/biome/bin/biome check $ROOT/native/computer --error-on-warnings` | 0 | `scoped-biome*`；11文件无修复 |
| B09 | 新快照E/check/workspace内 `bash $ISO npm run check` | 0 | `check/check.*`；1354文件无修复，pinned-deps/imports/locks/tsgo/browser-smoke全部通过 |
| B10 | 同快照packages/coding-agent内，`bash $ISO node ../../node_modules/vitest/dist/cli.js --run test/computer/service.test.ts test/computer/tool-definition.test.ts test/computer/integration.test.ts` | 0 | `check/computer-regressions.*`；3文件32/32 |

L05前root单独跑7个integrity/loader测试曾因platform键冲突1失败，修正后7/7；见`loader-contracts*`/`loader-contracts-retry*`。L01/L02临时诊断脚本和runner在收尾归档于E/repro，不成为产品binding。

B09/B10的快照包含1789 tracked +26任务新增文件，28材料目录/20147 entries，54 symlink均在副本内。复制后与检查结束source drift为空；无写回主树。root tsconfig不含native，因此L04是必要的额外生成类型门禁。本轮未重跑全套test.sh或native build，最近全套结果仍是B07的10失败，不宣称全仓测试全绿。

## P02 GUI 准入检查（无 driver / 无窗口动作）

`G=$ROOT/.artifacts/computer/p02-gui`。用户已确认专用fixture GUI及SDK内部必要的其他应用/窗口metadata读取与原前台焦点恢复；不是桌面隔离，实际内容观察/输入仍限fixture，REAL_APIS=false。以下只执行了无提示permission getter及自身PID的系统日志读取。

| ID | 实际入口 | exit | G内证据与范围 |
| --- | --- | --- | --- |
| G01 | `python3 /tmp/computer-p02-gui-preflight.py`，调用固定NODE的`currentMacOsPermissionStatus()` | 0 | `permissions.log`/`permissions-command.json`；PID47750、true/true，约0.104秒自然退出；不是最终行动进程证明 |
| G02 | `python3 /tmp/computer-p02-attribution.py`，等待自身Node ready后启动PID过滤`log stream`，再读TCC状态 | runner1 / Node78 / logger0 | `attribution/command.json`、`node.stdout`、`tcc.ndjson`；PID77212、false/false，自然退出；日志指向AgentPort责任链 |
| G03 | `$NODE --check /tmp/computer-p02-attribution.mjs` | 0 | G02前实际通过；脚本最终归档`repro/`，无driver、request/settings API或桌面发现调用 |
| G04 | 用户另行要求后，固定NODE执行`p02-permission-request/request-permissions.mjs` | 0 | 该兄弟证据目录的`command.json/events.jsonl/request.log/request.exit`；PID99320，request前后true/false，屏幕录制设置open成功；无driver |
| G05 | `python3 /tmp/computer-p02-recheck-permissions.py`（用户报告勾选后） | runner1 / Node78 / logger0 | `p02-permission-recheck/`；新Node5866仍true/false，TCC subject/responsible为debug AgentPort；无request/driver |
| G06 | `python3 /tmp/computer-p02-post-restart.py`（用户报告重启后） | runner1 / Node78 / logger0 | `p02-post-restart/`；新Node16473仍true/false，日志仍debug AgentPort；随后仅自身祖先/plist/codesign检查发现旧后台PID，磁盘签名有效，不是根因证明 |
| G07 | 用户确认改为正确调试app授权后，`python3 /tmp/computer-p02-after-correct-grant.py` | runner0 / Node0 / logger0 | `p02-correct-grant/`；Node30728两项true，同PID两服务Allowed；没有request/driver，解除历史权限条目阻塞 |

G04是用户明确授权的正常权限request/settings操作，替代此前禁止申请的局部限制；仍由用户手动授予，不自动点击/重置/提权。该轮屏幕录制仍未获准，T-007当时继续blocked；G07后才解除。SDK pins加载前校验、请求脚本syntax与任务validator通过；请求成功本身不是平台验收。

G02完整命令含`/usr/bin/log stream --style ndjson --level debug --timeout 8 --predicate <仅PID77212的com.apple.TCC过滤>`；8秒是日志观测期限，不是原生取消。较早G01通过不能覆盖G02当前失败；前后权限变化未确诊。不提升root，不读TCC数据库，不自动请求/授予/重置权限。

**G01—G07未运行**：真实driver、fixture/control窗口、observe/click/screenshot、native工作响应性、真实cancel/close/上游比较。它们只记录权限诊断；实际GUI实验见下节。

## P02 专用窗口原生实验

`V=$ROOT/.artifacts/computer/p02-live`；本节`ENV=$A/repro/computer-p02-env.sh`（已归档的实际helper）。以下cwd均为ROOT，除隔离check/Computer回归在V/check/workspace。环境helper仍默认GUI=false，实际GUI脚本显式要求`ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false`。Python父进程是本机证据助手，不是发布入口或OS sandbox。

| ID | 实际命令/入口 | exit | V内证据与范围 |
| --- | --- | --- | --- |
| V01 | `xcrun swiftc -parse-as-library -swift-version 6 -strict-concurrency=complete -warnings-as-errors -framework AppKit -module-cache-path ... -typecheck native/computer/test/fixtures/P02GuiFixture.swift`；同参数编译到fixture-build/P02GuiFixture | 0 / 0 | `fixture-build/report.md`含完整环境/命令/hash，Swift6.3.3；只是编译 |
| V02 | `ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 $V/run-gui.py smoke control-smoke-drained` | 0 | `control-smoke-drained/`；guard78、状态/Stop锁存/rearm拒绝、own visible/activeSpace/mainThread与EOF自然exit0，无SDK |
| V03 | `python3 $V/test-orchestrator.py` | 0 | `orchestrator-tests.log`，4/4无GUI合成子进程回归：退出前缓冲closed、多read尾部、截断尾部、done后额外effect |
| V04 | `bash "$ENV" "$NODE" native/computer/scripts/typecheck.mjs "$SDK"` | 0 | `native-types-final.log`；真实generated声明strict检查，含probe-gui.ts，无SDK执行 |
| V05 | `bash "$ENV" "$NODE" --test native/computer/test/*.test.ts` | 0 | `native-tests.log`，30pass/1native-load默认skip；新增probe opt-in guard4/4另有独立日志 |
| V06 | `node_modules/.bin/biome check native/computer --error-on-warnings` | 0 | `native-biome.log`，13文件无修复 |
| V07 | `python3 $V/check.py` | 0 | `check/check.log`完整npm check0（1356文件无修复）；Computer回归32/32；1818sourcepaths复制/结束drift为空 |
| V08 | `ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 $V/run-gui.py live native-comparison` | 0 | `native-comparison/`，raw/adapter真实driver各一次click、同窗口counter0→1→2、Stop转发取消只读观察、SDK关闭及三进程自然exit0 |
| V09 | `python3 $V/verify-live.py` | 0 | `verification.json/log`，原始事件与时间序列、两行动进程TCC归属/grants、81pins/四锁/两产物/源码边界核对 |

V08的fixture PID51161/window4860；raw PID51165、adapter PID52941都在自己的存活行动进程内getter两项true，并通过只过滤本PID的tccd日志确认责任宿主及两服务Allowed。manifest仅exact-window、get_window_state/click。两臂native effect **Unverifiable(2)** / route **Accessibility(0)** / delivery **Background(0)**、无escalation一致；counter是独立effect oracle，不把SDK effect改成Confirmed。

两臂各三次observe/click时，Node pending pong和AppKit主线程ack均早于实际SDK settlement。同步调用样本最大1.353ms/0.826ms；没有采样性能结论或完整TUI验收。adapter缺失manifest为正确Configuration且发生在owner获取前；同进程新adapter恢复成功，不声称半成品owner/global guard泄漏测试。

最终fixture stop-test走与按钮同一handler，父进程转发真实cancel：pendingAtCancel=true、匹配ESM UBJS AbortError、stopBeforeSettlement=true，然后shutdown→destroy，natural exits均0，无forced teardown。**未测试物理Stop点击、无遮挡像素或OS终态**。实际SDK settlement顺序不是escaped AX工作终结证明；禁止P01 bridge/提前释放desktop lease。本轮未改Rust/绑定/锁、没有screenshot/日常应用内容/模型请求，也未重跑完整test.sh；最近完整套件仍B07的10失败。

## P03 原生与生命周期门禁

`P3=$ROOT/.artifacts/computer/p03`；`D3=$P3/upstream/libs/cua-driver`。root命令通过`python3 "$P3/run.py" <evidence-name> <cwd> <command...>`记录，内部使用P03独立HOME/临时目录和复用的已审查Rust缓存；GUI/REAL_APIS默认false。各basename都有原始log/exit/command.json，早期失败不覆盖。

| ID | 实际命令/范围 | 结果 | P3证据 |
| --- | --- | --- | --- |
| P3-01 | `vitest --run test/computer/lifecycle.test.ts test/computer/host.test.ts test/pi-child-session-host.test.ts test/suite/agent-session-runtime.test.ts` | 111/111、exit0 | `lifecycle-fixed-root`；新增25例prepatch失败原文在`lifecycle-fix-evidence/`，最终lifecycle51项 |
| P3-02 | D3/rust：`cargo test --release --locked --offline --no-default-features -p cua-driver-core --lib controlled_ -- --test-threads=1` | 18/18、exit0 | `root-core-controlled` |
| P3-03 | 同上，filter `computer_desktop_lease` | 13/13、exit0 | `root-core-lease`，私有目录/子进程，不获取实际桌面lease |
| P3-04 | D3/rust：`cargo test --release --locked --offline -p cua-driver-sdk --lib controlled_ -- --test-threads=1` | 11/11、exit0 | `root-sdk-controlled` |
| P3-05 | 同P3-04，package `platform-macos` | 5/5、exit0 | `root-platform-controlled`，纯injected AX/focus/tree/press seams |
| P3-06 | D3：未改`node scripts/generate-uniffi-bindings.mjs`及`--check` | 0/0 | `bindings-generate`/`bindings-check`，内含locked/offline SDK build |
| P3-07 | `node scripts/stage-uniffi-library.mjs`；Rust `cua-driver-abi-header --check`；严格root/native TS emit | 全0 | `stage-native`/`header-check`/`typescript-emit`；完整命令在`qualify-generated.sh` |
| P3-08 | `node native/computer/controlled/typecheck.mjs "$D3/typescript"` | 初2、修正后0 | `controlled-types`/`controlled-types-fixed`；命名probe类型、host显式undefined联合；不是手改生成声明 |
| P3-09 | `node --test native/computer/controlled/test/*.test.ts` | 33pass/1load默认skip、exit0 | `controlled-tests-fixed`；P02独立30pass/1skip及types0另存`p02-native-tests`/`p02-types` |
| P3-10 | 显式`ALLOW_NATIVE_LOAD_TESTS=true`、`CUA_DRIVER_TYPESCRIPT_DIR=$D3/typescript`运行loader opt-in test | 1/1、exit0 | `controlled-load`，fresh child自然退出；无constructor/TCC/lease调用 |
| P3-11 | scoped Biome controlled+host；parent合成协议 | 0；8/8 | `controlled-biome-fixed`、`parent-tests`；初pin JSON格式失败保留 |
| P3-12 | `python3 "$P3/check.py" current-baseline --full-suite` | build/check/test 0/0/1；9既有失败/6文件，无新增 | `current-baseline/report.md`及`test-comparison.json`；不是全仓绿灯 |
| P3-13 | type-only调整后`python3 "$P3/check.py" final-check` | check0；191pass/5既有skip；controller38/38 | `final-check/`；1369文件无修复、结束source drift空 |
| P3-14 | `ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 "$P3/run-gui.py" smoke control-smoke` | 0 | `control-smoke/`：fixture44888/window5338状态/Stop/EOF；无SDK |
| P3-15 | `python3 "$P3/run.py" native-qualification "$ROOT" env ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 "$P3/run-gui.py" live native-qualification` | **1：失败** | `native-qualification/`：首个observe超时；Stop/close无回执、owner强制终止；不具备terminal资格 |
| P3-16 | `python3 /tmp/computer-p03-failure-evidence.py`（最终归档`qualification-failure/verify.py`） | 静态复核0；不是GUI重试 | `qualification-failure/verification.json`：20原始文件hash、9项pins、只读dirty marker与退出/事件核对；初轮摘要review hash缺字符失败另存 |

Rust最终19源补丁、锁/库与P02不变证据见`native-patch-provenance.json`、`root-native-inputs`/`post-generation-inputs`。coordinator与独立`native-review.md`核对了subtree final-Drop、lost terminal、遗漏writability gate、session snapshot回收修正；native terminal仅是driver-owned drain，不能宣称任意OS/应用效果已经结束。TS/harness审查见`boundary-review.md`。P3-15真实fixture资格失败，编译、pure barriers和load不替代它：owner56354的本进程TCC两项Allowed、fixture56350/window5617可见/主线程响应；首个observe dispatch及pending pong后60秒无observed，cleanup发送stop/close再等30秒仍无terminal/closed或自然退出，随后forced teardown。fixture自然exit0且counter一直0，无click命令；session/cross-process contention、clean successor及cancel receipt均未运行到。canonical marker只读检查仍为dirty generation1；不得重试、重置或以进程消失推断终态。完整边界见`qualification-failure/report.md`。

## P03 离线挂起修复验证

`R=$ROOT/.artifacts/computer/p03-offline-repair`；`DR=$R/upstream/libs/cua-driver`。实际命令由`python3 "$R/run.py" <name> <cwd> <command...>`保存，环境固定Rust1.97.1/Node24.15.0、offline、GUI/REAL_APIS=false。此轮未创建桌面owner、调用TCC/AX或获取/改写canonical lease。

| ID | 实际入口/范围 | 结果 | R内证据 |
| --- | --- | --- | --- |
| R01 | DR/rust：SDK精确`controlled_started_refusal_completes_both_subscribers_without_platform_dispatch` | 1/1、0 | `diagnostic-started-refusal`；不允许的工具名在platform lookup前拒绝 |
| R02 | SDK单订阅blocking-wake回归，随后加强为`controlled_foreign_subscribers_can_reenter_while_wake_is_pending` | 两版均原代码101、修复后0 | `regression-foreign-wake-{before,after}`、`regression-paired-wake-{before,after}`；失败为预期gate持锁循环 |
| R03 | 同P3-02—05、cwd换为DR/rust | core18/lease13/SDK14/platform5、全0 | `root-{core-controlled,core-lease,sdk-controlled,platform-controlled}`；含丢弃订阅不取消producer/不跳过drain；两处test-only格式修正后`sdk-controlled-formatted`14/14 |
| R04 | SDK locked/offline release；原generator及--check；N-API stage/header/TS emit | 全0 | `sdk-build`、`bindings-*`、`stage-native`、`header-check`、`typescript-emit` |
| R05 | patch严格正反向应用/hash；生成pins与原始证据校验 | 0 | `native-patch-formatted`、`capture-pins-formatted`、`verification-final`；2修复源文件/19合并patch文件，JS/声明与四锁未变 |
| R06 | `node native/computer/controlled/typecheck.mjs "$DR/typescript"`；controlled/P02 mock tests；Biome | 0；33pass/1skip、30pass/1skip；0 | `controlled-types`、`controlled-tests`、`p02-tests`、`scoped-biome`；22文件无写入 |
| R07 | 显式load-only opt-in，SDK路径换DR/typescript | 1/1、0 | `controlled-load`；fresh child自然exit0，无host/TCC/lease |
| R08 | `python3 "$R/check.py" final-check` | 外层1，内部npm check **2** | `final-check/check.log/.exit`；5个范围外模型ID TS2345，browser smoke未运行；副本只格式化1个既有narrative文件，主树未回写 |
| R09 | 同副本换回旧Computer patch/pins后`tsgo --noEmit` | **2**，相同5错误 | `root-types-before-repair`、`root-check-comparison.json`；修复输入已恢复，不修无关代码 |
| R10 | 同副本Computer/session选择与controller定向回归 | 193pass/5skip；38/38、均0 | `host-regressions`、`controller-regressions`；完整argv在各command.json |
| R11 | P02-live `shasum -a 256 -c SHA256SUMS`；仅新Rust片段rustfmt | 136项0；初1/修正后0 | `p02-seal`；`rustfmt-changed-regions{,-fixed}`；不格式化继承代码 |

R02证明原public terminal直接将foreign waker装到持锁core通知通道的局部缺陷；native proof monitor隔离后，同一阻塞回调期间cancel与两订阅re-poll可前进。不是原GUI的native stack，也未重跑P3-15。原失败20文件与P03的491Rust/81pins保留；dirty generation1不作自动恢复。两个静态汇总helper曾混淆外层exit1和实际command exit2；原日志保留，直接读取`.exit/command.json`后的`compare-root-check-fixed`通过，未重跑产品命令掩盖失败。最终静态清单排除其仍打开的日志，早期清单和格式前输入单独保留。

## P03 重启后一次性恢复与新准入检查

`Q=$ROOT/.artifacts/computer/p03-recovery`。命令由`python3 "$Q/run.py" <name> "$ROOT" <command...>`记录，修复SDK路径为`$DR/typescript`，没有覆盖原P03/P02证据。仅明确GUI命令开启GUI；REAL_APIS始终false。

| ID | 实际入口/范围 | 结果 | Q内证据 |
| --- | --- | --- | --- |
| Q01 | `sysctl -n kern.boottime`，与失败/修复完成时间比较 | boot1789756477，晚于两者 | `restart.json`，2026-09-18T18:34:37Z |
| Q02 | `python3 "$Q/prepare-admin.py"`；固定Rust1.97.1及已缓存rlibs | 0 | `recovery-helper-build`、`recovery-helper-inputs.json`；复用原样存储验证器，仅系统动态库，无SDK |
| Q03 | `python3 "$Q/test-recovery.py"` | 20/20、0 | `recovery-private-tests`；私有文件成功/争用/身份/权限/ACL/链接/marker/重复/缺失/写后D恢复，无canonical访问 |
| Q04 | `python3 "$Q/test-parent.py"`；`test-marker-snapshot.py` | 8/8、4/4、0 | `parent-tests-final`、`marker-snapshot-tests`；无GUI |
| Q05 | `python3 "$Q/verify-inputs.py"` | 0（恢复前/实测后） | `pre-recovery-inputs`、`post-run-inputs`；原/修复各81pins/491Rust，旧失败20/P02 seal136/离线133证据不变 |
| Q06 | `"$Q/recover" --canonical-after-confirmed-reboot` | **0，仅一次** | `canonical-recovery`；归档D1先sync，独占锁内同inode原位D1→C1并sync，不证明旧terminal |
| Q07 | `python3 "$Q/marker_snapshot.py"`恢复前/后精确marker只读检查 | 0 / 0 | `marker-before-recovery`、`marker-after-recovery`；inode134700982、0600、generation1保持；原marker归档`marker-before.bin` |
| Q08 | `env ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 "$Q/run-gui.py" smoke control-smoke` | 0 | `control-smoke`；fixture9395/window121、Stop锁存/EOF自然exit0，无SDK/物理Stop点击 |
| Q09 | 同Q08，`live native-qualification` | **1：准入失败** | `native-qualification`；probe9498 getter true/true，但responsible1084与requesting9498不满足旧脚本错误同PID条件；没有admit/dispatch |
| Q10 | `python3 "$Q/review-outcome.py"` | 静态核对0，不是重试 | `qualification-review.json`；fixture9494/window122 counter0、owner构造0、两自然exit0/EOF、marker仍C1、无强杀 |

Q09在宿主归属匹配处停止，不是新native observe挂起。TCC实际responsible bundle/path匹配已确认宿主，但脚本混同responsible/requesting PID；捕获没有逐服务Allowed决策行，不能直接放宽比较后忽略剩余门禁。没有继续修脚本/重试/再次恢复；先保留证据，后续修正和新尝试需另行确认。产品源码、patch/pins与依赖未变；本轮无新的全仓check或native terminal验收。

## P03 TCC修正与成功真实资格

`S=$ROOT/.artifacts/computer/p03-tcc`。均由`python3 "$S/run.py" <name> <cwd> <command...>`保存准确argv/exit/log；普通检查通过空HOME隔离，只有live显式GUI opt-in，全部REAL_APIS=false。

| ID | 实际入口/范围 | 结果 | S内证据 |
| --- | --- | --- | --- |
| S01 | `test-tcc-identity.py`对保存的PID9498日志运行旧/新角色条件 | 旧1/新0 | `identity-regression-{before,after}` |
| S02 | `python3 "$S/test-tcc-evidence.py"`；`test-parent.py` | 26/26、8/8，均0 | `tcc-evidence-tests`、`parent-tests-final` |
| S03 | `diagnose-tcc.py`及`qualify-tcc.py`无driver新进程准入 | 0 | `permission-capture`、`permission-qualified`；完整两服务Allowed链，不混同responsible/requesting |
| S04 | `env ALLOW_GUI_TESTS=true ALLOW_REAL_APIS=false python3 "$S/run-gui.py" live native-qualification` | **0** | 三实际进程各自准入、counter0→1、四terminal、争用拒绝、clean successor、四自然exit0/EOF、无强杀 |
| S05 | `python3 "$S/verify-live.py"` | 0 | `live-verification.json`核对原始事件/hash、marker同inode C1→D2→C2→D3→C3；不是再次GUI |
| S06 | `python3 "$S/check.py" final-check` | 外层1/check2 | 原样5模型ID TS2345；193pass/5skip、controller38/38，source drift0 |
| S07 | 三AI文件定向vitest，`run-isolated.sh`空HOME | 前1/后0 | `ai-before`：3fail/46pass/35skip；`ai-after`：49pass/35skip；无真实API，overflow只编译/发现与门控跳过 |
| S08 | `python3 "$S/check.py" repaired-check` | **0** | 完整check0/1369文件无修复，193pass/5skip与38/38；snapshot/live source drift0 |

S04实际PID：fixture24382/window240、owner24386、contender25381、successor27193。终态仅driver-owned drain，不扩为external effect完成；唯一click仍Unverifiable/Accessibility/Background。原P3-15未知终态保留，不用重启/成功复测补发旧证明。S07仅改变有来源的当前目录测试输入；无删除测试、cast绕类型或修改并发generator。没有重跑完整test.sh或真实模型。

## P04 离线有界执行/桥接与锁屏阻塞证据

`P4=$ROOT/.artifacts/computer/p04`；`D4=$P4/upstream/libs/cua-driver`。命令用`python3 "$P4/run.py" <name> <cwd> <command...>`记录，精确argv/cwd/exit均在`*-command.json`。环境脚本仍打印历史P03标签，但实际source/output/HOME为P04；通常GUI/REAL_APIS=false。以下load-only和genuine值测试均无native host/桌面调用。

| ID | 实际入口/范围 | 结果 | P4证据 |
| --- | --- | --- | --- |
| P4-01 | `check-plan.sh`，后`qualify-generated.sh`的controlled Rust/private lease tests | core25/platform16/SDK31/lease13，全0 | `check-plan-v2`、`platform-plan-tests-v3`、`sdk-plan-tests-v3`、`lease-tests`；首次platform编译缺unsafe的101保留 |
| P4-02 | 原generator与`--check`、copy-mode N-API、ABI header、strict TS emit | 全0 | `qualify-generated`及其逐项命令；locked/offline，继承warning保留 |
| P4-03 | `package-native-patch.py`、`capture-pins.py` | 0/0 | 27Rust文件strict apply/hash/reverse；579历史P03输入与四锁不变、81genuine pins；产品已选P04 |
| P4-04 | controlled typecheck；adapter/static与独立load-only | 0；34pass/1skip；1/1 | `adapter-types`、`adapter-tests`、`load-only`；无constructor/TCC/lease |
| P4-05 | native-boundary strict typecheck；root-aligned binding/integration typecheck | 修正前2/之后0 | `tool-types{,-v2}`、`loop-types{,-v2}`；严格边界不放宽，组合检查沿用根tsconfig；cleanup回调类型已修正 |
| P4-06 | 显式load-only opt-in运行`controlled/test/tool.test.ts`与`controlled/integration/loop.test.ts` | 8/8、4/4，均0 | `tool-tests`、`loop-tests`；实际生成值+fake host、真实AgentSession/faux；同八步请求9→3，不是desktop benchmark |
| P4-07 | probe strict types、Swift6严格并发/warnings-as-errors编译、独立control smoke | 全0 | `form-probe-types`、`form-fixture-compile`、`form-control-smoke`；无SDK control smoke，不证明物理Stop或解锁 |
| P4-08 | `python3 "$P4/check.py" bridge-check` | 0 | 完整check0/1376文件无修复、193pass/5skip及38/38；snapshot/live drift0；未重跑test.sh |
| P4-09 | 六次opt-in `run-gui.py live <name>`，每次重新TCC/Stop准入 | **均1：失败** | `form-native-qualification`、`form-diagnostic`、`form-branch-diagnostic`、`form-roots-diagnostic`、`form-helper-diagnostic`、`form-p03-baseline`；首observe失败、零form/click |
| P4-10 | `test-natural-failure.py before/after` | 前1/后0 | `parent-natural-before/after`；自然exit1/EOF仍报失败，但不能误标forced teardown |
| P4-11 | bounded console-state Swift helper；`test-console-gate.py`；真实前置拒绝 | metadata locked=true；6/6；预期1 | `console-state`、`console-gate-tests`、`locked-console-admission`；零fixture/SDK/TCC/owner children，C9未变 |
| P4-12 | 撤回临时诊断、原源cmp、locked/offline release重建 | 0/原hash一致 | `restored-native-build`；dylib `459fd177…`，probe恢复product loader；旧诊断证据另存 |
| P4-13 | `python3 "$P4/verify-blocked.py"` | 0，**p04Accepted=false** | `blocked-verification.json`核对155原始文件、27Rust/81pins/579历史输入/四锁；不覆盖已写报告 |
| P4-14 | 恢复后boundary/integration/probe types；选定adapter/loader/tool static tests | 0/0/0；32pass/7opt-in skips | `restored-types`、`restored-integration-types`、`restored-probe-types`、`restored-static-tests`；无SDK加载或GUI |

P4-09每次都有本进程完整两服务TCC Allowed、一条read-only terminal（cancelled=false/inputCommitted=false）、native-close→destroy、owner自然exit1/fixture自然exit0且EOF。四字段一直为空/counter0；同历史inode从C3到C9。首轮result.json的forced标签是harness缺陷，原始退出/EOF与paired回归证明并纠正；后五轮没有强制终止。诊断中的fixture AX根返回AXApplication/self/无window映射，冻结P03 baseline也失败。之后锁屏metadata为true，**未取得解锁对照，不把锁屏当唯一AX根因**。

锁屏guard在任何GUI children之前拒绝，缺失private lock key不等于已解锁，TCC/fixture/exact AX仍独立必要。上述是解锁前历史门禁；用户随后已手动解锁，新的资格证据见下节。无需恢复clean marker，不运行任何动作来绕过known-locked拒绝。历史汇总见`p04/report.md`。

## P04 解锁后实测与modal投影修复

继续使用P4/D4和逐进程console/TCC/Stop门禁，全部REAL_APIS=false。

| ID | 实际入口/范围 | 结果 | P4证据 |
| --- | --- | --- | --- |
| P4-15 | `run-gui.py observe unlocked-readonly --generation 9`；`live unlocked-form --generation 10` | 0/0 | 21节点完整只读；八步表单/四独立值通过；四terminal/四自然exit0，C11；`unlocked-verification.json`59输入/raw |
| P4-16 | strict scenario TS、Swift6 strict concurrency/warnings-as-errors、control smoke | 全0 | `scenarios-types`、`scenarios-fixture-compile`、`scenarios-control-smoke` |
| P4-17 | `run-scenarios.py 11` | 批次1：前5case通过，modal预定错误码断言失败 | layout/ambiguous/ref/stale/press；modal无input却code=condition_unknown；所有native clean，C17 |
| P4-18 | `modal-diagnostic.py scenario modal-readonly-diagnostic --case modal --generation 17` | 0 | 只读degradedReason=unexpected_modal_surface，无input，C18 |
| P4-19 | SDK `cargo test --release --locked --offline -p cua-driver-sdk --lib controlled_plan_executor_ -- --test-threads=1`；修复后filter controlled_ | 前101/后0 | `modal-executor-before`12pass/2fail为目标码差异；`modal-executor-after`33/33，覆盖前缀/未知/自由文本拒绝 |
| P4-20 | `qualify-modal.sh`及`verify-modal-inputs.py` | 0；input verifier初1/修正后0 | generator/check/stage/header/TS/apply/hash；只有2Rust变化；重建N-API字节变化如实pin，不声称可重复二进制 |
| P4-21 | `scenario-modal-fixed --generation 18`；`run-scenarios.py 19 modal-prefix partial cancel deadline` | 全0 | dedicated code；prefix1；Stop后counter1/无字段写入；deadline prefix6/首未投递6，C23；5次10自然exit0 |
| P4-22 | `verify-scenarios.py`两个闭合事件集合 | 0/0 | `scenarios-{initial,repaired}-verification.json`核对7+5runs、189+135raw files；包含失败而非删除 |
| P4-23 | boundary types/no-host load；tool/loop；`check.py modal-check` | 0；1/1；8/8；4/4；check0 | 全check1376files，仅任务pin JSON格式化已审查回写；193pass/5skip、38/38；live drift0；未重跑test.sh |

单次表单26042ms与deadline30954ms不是性能资格；deadline30s只关闭准入，仍等待drain。原生终态不证明外部effect完成。十AppKit场景已满足预期，但browser/更广输入/像素及P05–P08未验收；最新证据索引`p04/scenarios-report.md`。

## P04 browser transport离线基础

`BT=$ROOT/.artifacts/computer/p04-browser`；`RT=$BT/upstream/libs/cua-driver/rust`。所有Rust命令经`BT/run.py`使用固定1.97.1、locked/offline、无GUI/真实API；以下不是浏览器profile或GUI验收。

| ID | 实际入口/范围 | 结果 | BT证据 |
| --- | --- | --- | --- |
| P4-24 | RT：`cargo test --release --locked --offline -p cua-driver-core --lib controlled -- --test-threads=1` | 首38/38，最终40/40，均0 | `controlled-transport-tests`、`controlled-transport-final`；取消/writer readiness/flush/async drop/close barriers |
| P4-25 | 同P4-24，filter `browser::cdp_ws` | 25/25、0 | `cdp-neighbors`；含11个与P4-24重叠的新测试，不相加作独立数量 |
| P4-26 | reader失败后重复shutdown精确回归；failed flush关闭标记精确回归 | 两项before101，之后0 | `reader-repeat-{before,after}`、`failed-flush-before`；后者及poison后不poll_ready由P4-24验证 |
| P4-27 | SDK与platform-macos：`cargo test --release --locked --offline -p <crate> --lib controlled_ -- --test-threads=1` | 33/33、16/16，全0 | `sdk-neighbors`、`platform-neighbors`；继承warning保留，无新warning |
| P4-28 | scoped rustfmt；`python3 "$BT/verify-transport.py"` | 0/0 | `transport-final-format`、`transport-verification.json`；5文件incremental patch apply/hash/reverse、586历史输入/81pins/四锁不变 |
| P4-29 | `python3 "$P4/check.py" browser-transport-check` | 0 | `transport-global-check`及P4/browser-transport-check；全check1376files无修复、193pass/5skip、38/38、source drift0 |

`transport.patch`（9b6df0b6…）尚未应用到产品：没有SDK facade/生成接口变更或新原生库资格，没有Chrome/profile/桌面调用。精确绑定、当前origin授权、ref/frame身份、profile cleanup和typed计划须T-027另验收。完整test.sh未重跑。

## P04 browser原生异步生命周期子集

沿用BT/RT及固定locked/offline环境。具体命令在`BT/validate-lifecycle.sh`和逐项command.json；无Chrome/profile/GUI/TCC/lease/model调用，没有新的生成/公开ABI或产品pin资格。

| ID | 实际入口/范围 | 结果 | BT证据 |
| --- | --- | --- | --- |
| P4-30 | RT core filter `controlled`，同P4-24命令 | 56/56、0 | `lifecycle-core-final`；有界resource注册、ancestor revoke、reverse drain、lost/panicking cleanup、实际pool/reader/writer |
| P4-31 | RT core filter `browser::cdp_ws` | 33/33、0 | `lifecycle-cdp-neighbors`；其中19与P4-30重叠，不相加作独立数 |
| P4-32 | registered pool首连foreign session；首失败握手重拨的精确回归 | 两项before101，after0 | `lifecycle-foreign-pool-{before,after}`、`lifecycle-first-handshake-before`及P4-30；peer均显式关闭/等待后断言 |
| P4-33 | SDK/platform-macos filter `controlled_` | 40/40、16/16，全0 | `lifecycle-sdk-final`、`lifecycle-platform-neighbors`；SDK7新barrier覆盖lost facade/waiter、paused child Drop、subtree与host并发、late child、sticky failure |
| P4-34 | 八文件scoped rustfmt check；`verify-lifecycle.py` | 0/0 | `lifecycle-format-check`、`lifecycle-verification.json`；9文件patch27a67104 apply/hash/reverse；当前589→593源；586历史P04源/81pins/四锁/产品输入不变 |
| P4-35 | `python3 "$P4/check.py" browser-lifecycle-check` | 0 | `lifecycle-global-check`及P4/browser-lifecycle-check；完整1376files无修复、193pass/5skip、38/38、所有drift0 |

`lifecycle.patch`增量基于transport.patch，不直接应用upstream；详见`lifecycle-report.md`。只验证驱动资源清理，bootstrap/profile/process/精确窗口/origin/frame/ref/typed计划及GUI资格仍待；完整test.sh未重跑。

## 对应方案场景

| 场景 | 最小验证 | 当前证据与仍缺事项 |
| --- | --- | --- |
| T01 普通 coding | 真实 session/faux 首次请求工具集合与 native factory 计数 | C03/C07 ordinary/noTools 不含 Computer、注入 factory 零调用；无默认 native loader；生产激活待 P07 |
| T02 转换/注册/snapshot | 双向 wrapper、registered/custom tool；最终准入拒绝与 scheduler barrier | C02/C03/C07 通过：两方向保留、snapshot 冻结、实际宿主拒绝与独占等待；宿主显式配置，不是默认全局策略 |
| T03 single-flight | 初始化 barrier、失败回收、重复进入 | L05/V05 mock单次创建/失败缓存/close竞态；V08真实缺失manifest失败缓存、无owner close后新adapter恢复；半成品owner/完整泄漏未验证 |
| T04 版本/架构 | native version/hash/arch 与普通 coding fallback | D06—D14编译/生成/静态产物；L01—L06运行ABI/checksum/加载/codec通过，L05拒绝平台/输入不符；未测生产fallback或其他Node/Bun |
| T05 TUI 响应 | native 期间事件循环/停止 | V08/V09六次observe/click内Node pipe与AppKit主线程响应通过；真实Stop handler转发取消通过；完整TUI/物理Stop未测 |
| T06 lease 排队取消 | scheduler barrier、队列长度、零投递 | P3-01宿主共享scheduler等待时撤权、取消、零后续投递；P3-02原生queued-worker/ancestor barrier通过。真实阻塞AX入口不可直接观测 |
| T07 pre-handle abort | 原生取消锁存先于副作用 | P3-09覆盖allocation/start同步重入与preabort零分配；P3-02/04原生inert cancel/独立producer通过，不把foreign waiter abort当terminal |
| T08 祖先撤权 | child authority 缩窄后下一 native gate 拒绝 | P3-01真实SDK/faux child及同步controller通知、P3-02祖先gate通过；P4-01顺序plan gate纯原生测试通过，P4-21真实Stop后无尾部输入；实际祖先撤权仍以barrier测试为证 |
| T09 switch/fork/reload | 旧引用失效、异步 close 收敛 | P3-01覆盖new/fork/resume/import/reload/navigation、reentrant narrowing、成功drain后才续代；真实native场景需单独fixture证据 |
| T10 两 owner / 跨进程 | 同 desktop exclusive、不嵌套 lease、协作锁恢复 | host33项及P3-03私有flock回归；S04/S05真实session/process拒绝争用、clean后successor；无自动dirty恢复 |
| T11 JS timeout/native 未停 | terminal ack 前不释放；unknown/quarantine | P3-01/02/04/09覆盖结果先失败/terminal先失败且result永远pending、dropped waiter、lost producer与sticky quarantine；无timeout unlock |
| T12 有界批操作 | 同一真实 loop 比较请求数与后置条件 | P4-15真实八步表单/独立四值通过；P4-06/23真实loop/faux请求9→3；不是完整任务性能资格 |
| T13 stale/ambiguous/layout | 拒绝过期引用、不自动换目标 | P4-17/21真实layout/ambiguity/detached ref/stale snapshot/modal边界通过；像素仍未测 |
| T14 partial/unknown | 完成前缀、无 replay、ID 内容冲突 | C01/C03及P4-01/06纯native/fake ID冲突/无replay；P4-21真实modal/条件失败prefix1、Stop后unknown、deadline prefix6通过 |
| T15 late window/focus | 全部 detector 路径差分与焦点 lease | V08保留并运行SDK原后台click路径，未做focus/late-window差分或优化；仍归P05 |
| T16 裁剪/缺失观察 | 不以未出现当全局不存在 | P05/P07 未验证 |
| T17 图像/DPI | 图像尺寸/裁剪/坐标往返映射 | P06 未验证 |
| T18 feature 裁剪 | 实际依赖闭包、二进制与初始化 | D04/D05/D09图谱、D06/D11产物；L01/L03/L06只证明无driver加载初始化，没有生产裁剪 |
| T19 browser profile | 精确绑定/授权/session generation | P4-24–35验证transport及native session资源清理、首连身份/失败不重拨；独立空白profile/本地任务已授权但准备/绑定/GUI资格未运行；日常登录profile不在范围 |
| T20 context/compaction | 同视图估算/投影、消息配对和 cache 前缀 | C04 既有 compaction/queue 回归通过；Computer/image 长上下文投影待 P07 |
| T21 独立安装 | 无 workspace 偶然依赖、无在线下载 | 普通 offline build 通过；Computer 打包未实现 |
| T22 关闭/崩溃 | 句柄/buffer 回收，无恢复输入 | V08仅P02 SDK settlement；P3-15旧owner仍未知。Q06一次恢复不補发旧证明。S04/S05新owner/successor四terminal及native-close→destroy、四自然exit0通过，marker C3；P4-09六次只读失败仍有terminal/clean close与自然exit1/EOF、历史C9；P4-15/17/18/21后clean C23及自然退出另验，buffer压力未测 |

## 后续命令必须满足的限制

- 新测试文件逐个定向运行；与实际 AgentSession/createAgentSession 和 faux provider 接通，不复制简化 loop。
- 并发使用 barrier，不能用 sleep 证明时序。
- 构建/生成保持固定工具链、额外 locks 与 offline；原脚本的 `--check` 也会构建。下载仅限已批准的白名单/固定锁 hydration，不因失败静默升级或切换为在线生成。
- 原无GUI轮只授权加载/codec/标量ABI；最新GUI授权另见任务记录。SDK test executable/upstream loader test glob含create或未知副作用仍不准任意运行，不据加载通过扩大范围。
- 当前GUI授权包含专用fixture/截图/像素、独立空白browser profile/本地任务及必要SDK附带metadata/焦点行为；每个行动进程仍须新资格检查。用户已手动解锁并重新资格通过；known-locked guard继续生效，再次锁屏时不启动GUI，不自动解锁或恢复clean marker。不继承日常登录环境，权限缺失时仅正常申请并由用户批准。真实模型另限qd/kmodel_latest high有界opt-in，不运行无界/其他模型e2e。
- Node 与 Bun 分开验收；当前平台目标不等于已支持平台。
