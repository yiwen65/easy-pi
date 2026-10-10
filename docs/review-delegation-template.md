# 审查委派模板（防虚构版）

> 来源：2026-09-23 两周 commit 审查中，3/4 份委派报告的 16 条发现全部虚构
> （引用符号在源码与 git 历史中均不存在）。根因：生成侧在"声称覆盖面 vs
> 实际阅读量"的缺口上用风格一致的虚构填满交付格式。
> 配套工具：`node scripts/verify-review-report.mjs <report>` —— 机验报告中的
> path:line 与符号引用。详见 LEARNS.md「委派代码审查大面积虚构发现」。

## 使用方式

派生审查 agent 时，将下面的「任务契约」填入 objective，替换 `<范围>`、
`<基线>`、`<特殊关注>`。单元规模上限：**约 3000 行新增/变更代码**；
更大范围拆成多个单元，宁可串行多轮。

## 任务契约（复制到 spawn objective）

```text
对 /Users/w/Projects/easy-pi/pi 仓库做只读代码审查。你不得修改、创建任何文件；
仓库中可能有其他 agent 并行工作，文件内容以你 read 到的为准，发现行号引用
git show HEAD:<path> 的提交版本并注明。

审查基线：git diff <基线>..HEAD -- <范围>
审查范围（仅此，排除 test/、docs/、fixtures）：<范围>
特殊关注：<特殊关注，如 SSRF/并发/生命周期>

【覆盖率契约】
- 交付第一节必须是覆盖清单：每个你**用 read 完整读过**的文件一行
  （路径 + 行数）；未完整覆盖的文件列入「未覆盖」。
- 覆盖率 <100% 是合法结果：报告覆盖率即可。禁止为了让报告"有料"而补充
  你未实际核实的发现。

【发现契约】
- 每条发现必须：精确 path:line（read 核对的当前行号）、现实触发路径、
  因果解释、实际影响、最小修复方向、Certainty（Confirmed/High/Conditional）。
- 交付前的硬性自检：对报告中每个反引号符号与每个 path:line 各跑一次
  `rg -n -F "<symbol>" <path>`，rg 无匹配的发现必须整条删除，不得交付。
- 无发现时明确写 No actionable issues found in the reviewed scope，
  这被视为完整交付，不是失败。

【格式】
### 标题
- Severity / Axis / Location / Problem / Impact / Recommended fix / Certainty
最后附「Validation gaps」（未覆盖的文件、未跑的检查）。
```

## coordinator 接收侧

1. 收到报告后先跑 `node scripts/verify-review-report.mjs <报告文件> --strict`；
   任一 suspect 输出 → 整份报告降为"未验证线索"，逐条人工复核或退回。
2. 覆盖率声明抽查 1–2 个文件（对照该 agent 历史的 read 调用数）。
3. 任何修复授权前必须完成第 1、2 步；不存在"按报告批量批准"。
