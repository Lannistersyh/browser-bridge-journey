#!/bin/bash
cd "$(dirname "$0")"
echo "socket: $([ -S /tmp/edgebridge.sock ] && echo 存在 || echo 不存在)"
echo "manifest: $([ -f "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.edgebridge.app.json" ] && echo 已安装 || echo 缺失)"
echo -n "测试: "
node client.mjs tabs 2>&1 | head -6
