# Store 组完成记录

生产冻结。接口SafeStorageLike/JSON/base64/IPC不变，无自动迁移、默认值写回或新缓存。

## 修改

- Profile/Search/MCP：先完成新密文的解密返回值验证，再同步提交，防止报保存失败却已替换原值。Profile加密/解密之后同步重读提交，继续保持并发安全。
- MCP reload失败清空内存配置并close旧连接；写操作add/remove/toggle先成功reload。startup仍reject交main仅启动catch，overview错误交现有设置UI，不伪装空配置。
- 既有core generation/disabled屏障阻止缓存的旧工具在close后复活；不改Core。

## Red→green

1. MCP读取失败后旧工具仍在 → 撤下并关闭。
2. MCP add/remove/toggle在读失败下写盘 → 写前读取门禁。
3. 读恢复复活旧连接 → 只读恢复配置，显式reconnect才连接。
4. Profile create/update后解密失败已改盘 → 写前校验。
5. Search保存解密失败已换旧key → 写前校验。
6. MCP createServer解密失败已新增 → 写前校验。

## 验证

- Desktop定向58/58通过（含真实临时文件原子写失败）。
- 既有设置UI20/20通过，无UI修改。
- 主代理独立复跑4 store/service文件46/46通过。
- 生产ESLint、8文件Prettier、diff --check通过。
- 组内desktop typecheck曾通过；最后仅A进行中的windows-dpapi测试类型错误，需最终统一复验，不计本组全仓绿。

## 文件

- desktop/src/profiles/profile-store.ts
- desktop/src/search/search-settings-store.ts
- desktop/src/mcp/mcp-store.ts
- desktop/src/mcp/mcp-service.ts
- 对应tests/profiles/profile-store、tests/search/search-settings-store、tests/mcp/mcp-store、tests/mcp/mcp-service。

main由主代理完成单实例adapter及启动catch，生产build/E2E/全仓检查尚待集成。
