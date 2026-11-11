# Linux 迁移说明（本机云电脑）

生产仓库：`/workspace/baidu-feishu-automation`
数据目录：`/workspace/baidu-feishu-data`（Chrome 专用 profile、文稿下载、last-run、日志）

## 调度

系统无法安装 crontab 守护进程（apt 源不可用，且 PID 1 不是 systemd）。
改用 `bin/supercronic` 读取本仓库 `crontab`，时间与原 Windows 任务相同：

`0 0,4,8,12,16,20`（Asia/Shanghai / CST）

登录完成前，crontab 里的生产行保持注释。启用：

```bash
/workspace/baidu-feishu-automation/bin/enable-cron.sh
```

停用：

```bash
/workspace/baidu-feishu-automation/bin/disable-cron.sh
```

## 浏览器隔离

批次只启动自己的 headless Chrome：

- profile：`/workspace/baidu-feishu-data/chrome-profile`
- CDP 端口：9333

不会连接或结束桌面浏览器（端口 9232、`/home/box/chrome-profile/Fork-10`）。

## 状态

- `/workspace/baidu-feishu-data/state/last-run.json`
- 需要百度扫码时：`/workspace/baidu-feishu-data/state/baidu-login-qr.png`
