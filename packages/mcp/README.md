# @zhixuan92/multi-model-agent-mcp — DEPRECATED

This package has been replaced by **[`@zhixuan92/multi-model-agent`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)** in 3.0.0.

The 3.0.0 release removes all MCP server support. Use the new standalone HTTP service + client-installable skills instead.

## Migration

```bash
npm uninstall -g @zhixuan92/multi-model-agent-mcp
npm install -g @zhixuan92/multi-model-agent

mmagent serve              # start the daemon
mmagent install-skill      # install skills for your AI client
```

See the [3.0.0 CHANGELOG](https://github.com/zhixuan312/multi-model-agent/blob/master/CHANGELOG.md#300) for details.

## About this version (2.8.1)

`2.8.1` ships a 10-line stub that prints a migration notice and exits with code 1. It does not function as an MCP server. Installing or invoking `mmagent` / `multi-model-agent` from this package will redirect users to the new package.
