# F27 实施与验证记录

基线f3e674f，分支fix/credential-durability。根因与批准方案见spec.md及ADR0027。

## Red

- `CODEXLIKE_PACKAGED_EXE= node packages/desktop/e2e/credential-durability.mjs` 在原f3e674f产物运行，exit1。全新目录首次Profile保存后立即kill，下一进程公开provider-profiles:list抛 `Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.`。没有预热/等待/真实凭据。
- 原pre-push失败：launch-state-target场景⑥相同根因，保持场景本体不削弱。

## 集成改动

- main ready后创建一个credentialStorage实例，供Profile/Search/MCP共享。
- Search读取失败先撤缓存并保留脱敏错误，启动catch允许建窗，工具resolver不会伪装成未配置；MCP启动catch同理，service负责撤下/关闭失效工具，overview继续报错供UI。
- 新credential-durability专项进入all链首位：3种凭据分别首写立即kill、旧格式只读兼容、损坏Search/MCP仍可建窗且文件不变。
- subagent-interrupted撤掉此前正常退出预热，恢复首次配置即执行/强杀的回归。
- ADR0027与README明确CurrentUser作用域、平台要求、单向旧版本兼容、无自动迁移及不承诺整机断电耐久性。

## 当前检查

- 新E2E语法、ADR检查（27篇）与定位器检查（45场景另豁免6）通过。
- 阶段性desktop exec tsc --noEmit通过（不产生dist）。
- Store组生产冻结：desktop定向58/58、既有设置UI20/20通过；主代理另复跑4文件46/46通过。已修提交前解密校验和MCP读失败撤缓存/关闭连接，详见store-notes.md。
- 阶段性desktop tsc再次通过；主代理main eslint及既有Settings UI定向通过。
- Adapter生产冻结，定向41测试通过；当前三包build已完成。新真实凭据专项已绿：Profile/Search/MCP各自首次写入立即kill后跨进程解密；真实Electron旧格式只读兼容；坏Search/MCP仍建窗错误可见且文件不变。
- 独立store/main复审2项P2已补：MCP新增decrypt等待的旧快照覆盖由B加decrypt闸门red→green并重读提交；Search读取重试需同步刷新工具缓存由主代理抽IPC接缝，2项测试先1红后全绿。

## 待验收

- [x] Adapter新旧格式、系统进程限量/脱敏、并发/缓存回归：44定向测试通过；kill失败不close永久挂起P2已用1s回收宽限+protector永久关闸修复，false/throw/true无close三项红→绿，原安全reviewer确认关闭。主代理4文件56测试独立复跑通过。
- [x] 三种store失败保旧、只读混合密文和启动错误恢复；独立review的MCP/搜索缓存两项已整改并确认关闭。
- [x] 当前三包构建与全仓typecheck/lint/test通过：Core587、desktop504+1skip、UI538，总163文件1629pass/1skip（最终runner补漏后还需重跑）。
- [x] 首次保存立即kill真实E2E（3store各首写，无预热）及legacy/坏配置保护通过；原launch-state-target全部场景通过。subagent-interrupted去预热后首次因IPC建Profile未通知已挂载UI卡准备，改为真实设置页操作后，无预热强杀恢复通过。
- [x] 独立安全/兼容及Standards/Spec复审完成，3条边界全部整改并由原reviewer确认关闭，详见review.md。最后runner补漏产物再次build，credentials与完整launch-state-target重新通过。
- [ ] 提交合并main、重新dist与打包专项。
- [ ] 正常pre-push全量门禁与origin/main一致性确认。
