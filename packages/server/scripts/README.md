# mma service templates

Templates for running `mma serve` as a background user service.

## macOS (launchd)

```bash
cp packages/server/scripts/launchd/com.zhixuan92.mma.plist ~/Library/LaunchAgents/
sed -i '' "s|PLACEHOLDER_HOME|$HOME|g" ~/Library/LaunchAgents/com.zhixuan92.mma.plist
launchctl load ~/Library/LaunchAgents/com.zhixuan92.mma.plist
```

- Check logs: `tail -f ~/.mma/logs/daemon.stderr.log`
- Stop: `launchctl unload ~/Library/LaunchAgents/com.zhixuan92.mma.plist`
- Restart (after npm upgrade): `launchctl kickstart -k gui/$(id -u)/com.zhixuan92.mma`

## Linux (systemd user unit)

```bash
mkdir -p ~/.config/systemd/user
cp packages/server/scripts/systemd/mma.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mma
```

- Check logs: `journalctl --user -u mma -f`
- Stop: `systemctl --user stop mma`
- Restart (after npm upgrade): `systemctl --user restart mma`
