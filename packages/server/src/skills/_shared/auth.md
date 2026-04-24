## Authentication

Every request to the multi-model-agent server requires a Bearer token.

### Obtain the token

**From environment variable** (preferred):
```
MMAGENT_AUTH_TOKEN=<token>
```

**From CLI**:
```bash
mmagent print-token
```

### Use the token

Add to every request as an HTTP header:
```
Authorization: Bearer <token>
```

### Shell helper

```bash
TOKEN="${MMAGENT_AUTH_TOKEN:-$(mmagent print-token)}"
curl -H "Authorization: Bearer $TOKEN" ...
```

If the server returns `401 unauthorized`, re-run `mmagent print-token` —
the token may have changed after a server restart.
