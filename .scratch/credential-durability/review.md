# 凭据耐久性修复复审

基线f3e674f，review为工作区diff加新增文件；排除用户LICENSE/.zcode。所有review只读，测试执行由实现者与主代理分别记录。

## Standards

硬性新增违反0，非阻塞possible Duplicated Code 1：三个store测试的fake protector/legacy夹具重复，可后续小型共享工厂；不为此改变生产架构。引用规范为根AGENTS/CODING_STANDARDS/GLOSSARY与ADR0027。

## Spec

最终未发现新增强P1/P2。共享Adapter、严格版本分派、legacy只读不迁移、CurrentUser系统桥接、失败保旧、首次save立即kill及去预热均符合批准规格。最终打包/prepush验收仍需执行后核销。

## 专项正确性/安全检查与整改

1. Search设置重试仅store.get成功却没恢复searchSource/error缓存：已提取search-settings-ipc，由get共用refresh。IPC测试先红1后绿2，原reviewer确认关闭。
2. MCP createServer新增提交前解密等待会覆盖期间remove/disable：已toConfig之后同步重读合并写，decrypt闸门回归红→绿，原reviewer确认关闭。
3. runner timeout后kill false/throw/no-close可永久等待：已增加1秒回收宽限，无close先永久disabled再拒绝。队列和新调用不spawn，迟到close不重复清理不解锁。false/throw/true-no-close3回归红→绿，44 storage tests绿，原安全reviewer只读确认关闭。

除此之外无新增强P1/P2。未把同用户恶意进程或整机断电保障误归本次范围。对无法终止的原进程不能声称已经回收，实际处理是有限失败并停止新增系统进程，重启/新实例才恢复。
