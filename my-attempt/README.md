# my-attempt

这是我自己做的浏览器桥（原名 EdgeBridge），完整可运行。

**476 行，9 个文件，9 个命令，零 TCP 端口。**

- `extension/` — MV3 扩展（`background.js` 158 行）
- `native/` — 原生消息宿主（`host.js` 87 行）+ 注册清单
- `client.mjs` — agent 侧客户端（70 行）
- `status.sh` — 自检

## 独立仓库

完整版（含 README、License）在：https://github.com/Lannistersyh/edgebridge

## 说明

这套东西**现在不需要运行**了——[BrowserSkill](https://github.com/Tencent/BrowserSkill) 功能更全。
放在这里是为了让这份记录有实物。

如果你确实想跑它：

```bash
# 1) 加载扩展
#    edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 extension/
# 2) 装原生宿主
cp native/com.edgebridge.app.json ~/Library/Application\ Support/Microsoft\ Edge/NativeMessagingHosts/
# 注意：清单里的 path 和 allowed_origins 需按你的实际路径/扩展ID 改
# 3) 自检
./status.sh
```

## License

MIT
