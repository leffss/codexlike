# 独立复审与整改

基线：cbc87ff。用户批准不提交，实际范围为 `git diff cbc87ff -- packages/` 加本轮未跟踪新增文件；排除用户原有LICENSE/.zcode。两轴独立审阅，不用单轴结论替代另一轴。

## Standards

- 硬性规范违反：0。
- 非阻塞建议：2处 possible Duplicated Code——设置加载错误/重试呈现；主/子工具调用归一化。此次保留小修边界，不重写两套循环或设置框架。
- 门禁：所有交互面相关E2E需实跑，结果由INTEGRATION.md核销；静态复审不代替执行。

## Spec

初次独立复审2项P2：

1. F08悬空symlink真实目标去重遗漏。03已补FS边界文件symlink和真实dangling junction两个失败回归，在targetIdentity对无法realpath的symlink明确拒绝，整批零写。apply-patch专用17/17通过，待最新产物全仓验证。
2. F04 lazy思考正文后的message-order旧E2E默认折叠直接读正文。主代理已适配两处：读取前展开、校验后收回，保留后续交互初态。该脚本含真实系统剪贴板，按批准约束只做静态语法/定位器检查，不运行；实际lazy行为由独立jsdom及其它相关Electron场景验证。

没有确认无关scope creep；其它26项当前未发现新增高可信阻塞偏差。C01按可控异步边界完成防御性修复，未冒称原真实Electron时序已复现；C02经真实Task/SQLite确认后修复。

## 补充正确性复查

### 宿主/存储/构建

产品范围未发现新P1/P2。新构建加载测试曾让外置Playwright读取宿主DEBUG_FILE而越过VM隔离；临时sentinel冷进程确实从原文变空，已用真实依赖加载边界的同步环境白名单+finally恢复修复。轻量probe验证日志不变、缓存归隔离目录、env恢复；主代理复跑build-loading 5/5通过。

### Core故障边界

R1：abort listener结算失败/后置状态写异常产生uncaught或悬挂。05已按真实Task abort故障注入补红绿；终止请求受控结束、不批准、普通respond失败仍可重试、迟到授权拒绝。

R2：已abort时flush存储错被当取消吞掉，报告假成功。05已独立保留flush错误，报告failed/isError，并验证已写轮次不重复。

这两项最终4文件102测试通过，无unhandled errors；tsc/lint通过。已要求基于最终生产版本重新build，不能拿旧产物E2E覆盖新修复。

## 最终复验

- [x] 最终全仓检查与测试通过：默认build/test退出0，160文件1570pass/1明确skip；typecheck/lint/ADR/定位器/补丁格式退出0。
- [x] 19项选定隔离E2E通过，最终产物复跑结果见INTEGRATION.md；强杀场景明确已完成首次配置基线，另有未修首启密钥风险票08。
- [x] 原reviewers仅针对整改再读并确认关闭：宿主review的DEBUG_FILE隔离P2、Core的R1/R2、Spec的F08与F04测试适配均已关闭。Standards硬违反0，2项非阻塞重复代码建议保留；原26修复范围无待处理阻塞项。

新发现的Electron首次密钥耐久性问题未包含在上述关闭结论中，见issues/08-electron-first-key-durability.md，必须在最终交付明确披露。
