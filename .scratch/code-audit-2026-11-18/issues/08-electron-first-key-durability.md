# 08：新发现——Electron 首次加密密钥延迟持久化窗口

Status: done
Priority: P2
Blocked by: none

用户后续已批准并实施 ADR 0027 的 Windows DPAPI CurrentUser 新格式方案；新鲜目录三种凭据首次save→立即kill→重启解密、原 launch-state-target ⑥、去预热的子代理强杀恢复均已通过。专项review三个边界已整改并确认关闭，全仓检查通过；打包/推送交付进度见 `.scratch/credential-durability/verification.md`。以下保留最初发现记录。

## 发现与影响

补齐E2E独立userData/sessionData后，subagent-interrupted在全新目录首次创建Profile、随即强杀应用、重启时出现：

`Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.`

业务Profile JSON已写入，但Electron首次生成的加密密钥仍处在Local State延迟提交窗口。已初始化环境的正常退出/重启和任务恢复无该问题。不能把新用户首启强杀路径算成已修复或已验证。

## 已验证矩阵

独立探针使用Electron45.2.3/Chromium156、无窗口、不加载本项目，仅人工假字符串和自己临时目录：

| 场景                                                    | 跨进程结果                                 |
| ------------------------------------------------------- | ------------------------------------------ |
| 全新目录 async encrypt，同进程decrypt正常，立即强杀     | 重启decrypt失败，与E2E相同异常             |
| async encrypt后正常app.quit，再重启                     | 成功                                       |
| 相同隔离目录先初始化并正常退出，再运行/强杀/重启        | 成功                                       |
| 产品默认sessionData=userData布局，首次encrypt后立即强杀 | 同样失败，并非测试分离目录专属             |
| 首次encrypt后session.flushStorageData，再立即强杀       | 失败（该API仅DOMStorage）                  |
| 首次encrypt后await cookies.flushStore，再强杀           | 失败（该API仅cookie）                      |
| 改用已弃用同步encryptString，立即强杀                   | 仍失败                                     |
| 首次encrypt后12秒，观察Local State已出现，再强杀        | 成功，说明是延迟提交窗口，不是只能退出保存 |

本机声明与运行时没有公开app.flushLocalState/prefs提交API。分离目录时Local State在sessionData，不在userData根；未读取真实密钥或用户文件。

## 最初审计轮的处理边界（历史记录）

本轮**不把它标成修复完成**。不采用明文、删配置、切换弃用同步API、固定sleep或猜私有Local State格式作为修复。

`subagent-interrupted.mjs`现明确测试“已完成首次配置”的任务恢复：场景独立目录创建Profile→正常退出→确认跨进程可解密→开始委派→真正强杀→重启。该路径已通过。首启崩溃耐久性由本票单独跟踪，不能用预热夹具的绿色结果覆盖。

## 后续建议

先确认Electron支持的密钥耐久性方案或上游修复，再选择受支持的初始化/保存屏障或有版本的存储方案；任何替代存储都需明确旧密文兼容、迁移、系统加密与故障恢复策略，另做实施计划。不得在本轮不经验证地替换用户凭据存储。

## 复现材料与局限

本轮原E2E失败日志：`C:/Users/leffss/AppData/Local/Temp/zcode-bash-ER3yKT/sess_64d1462b-27dc-4fef-a0f2-c039be56a502/call_DyXMEJDLfBo4DQnstjOjI6K8-stdout.log`。

独立无窗口探针结束后已清理脚本/fixture及其进程，不能把临时脚本路径当长期可重跑附件。判据为probe的restore-failed事件及原始解密错误，不是app.quit退出码。未来回归应固化这条新鲜目录加密→强杀→解密链，不能仅在同进程重建store。
