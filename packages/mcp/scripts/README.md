# mmagent service templates

Templates for running `mmagent serve --http` as a background service.

## macOS (launchd)

```bash
cp packages/mcp/scripts/launchd/com.zhixuan92.mmagent.plist ~/Library/LaunchAgents/
sed -i '' "s|PLACEHOLDER_HOME|$HOME|g" ~/Library/LaunchAgents/com.zhixuan92.mmagent.plist
launchctl load ~/Library/LaunchAgents/com.zhixuan92.mmagent.plist
```

Check logs: `tail -f ~/.multi-model/logs/daemon.stderr.log`
Stop: `launchctl unload ~/Library/LaunchAgents/com.zhixuan92.mmagent.plist`
Restart (after npm upgrade): `launchctl kickstart -k gui/$(id -u)/com.zhixuan92.mmagent`

## Linux (systemd user unit)

```bash
mkdir -p ~/.config/systemd/user
cp packages/mcp/scripts/systemd/mmagent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mmagent
```

Check logs: `journalctl --user -u mmagent -f`
Stop: `systemctl --user stop mmagent`
Restart (after npm upgrade): `systemctl --user restart mmagent`
