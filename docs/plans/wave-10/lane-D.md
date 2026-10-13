# Wave 10, Lane D: token mode lets a browser in (Amendment 137)

The text below is for the merge to apply; this lane does not edit CONTRACT.md or docs/MANUAL.md.

## CONTRACT

### Amendment 137 — post-merge, applied. **A browser opens the sockets in token mode with `?token=`.**

Daemon only (`daemon/src/index.ts`, `daemon/src/terminal/verify.ts`). Asked in the 12 Oct TODO's loose
end "Token mode" and the wave 10 plan (Lane D). With `CONDUCTOR_TOKEN` set, the feed socket (`/ws`) and
the terminal socket (`/ws/term/:id`) were refused to a browser even with the right `?token=`. The
cause: the bearer hook in `index.ts` runs on every request, the WebSocket upgrade included, and wanted
`Authorization: Bearer …`, which a browser cannot set on a WebSocket. `/ws` had this before the
terminal existed, and `terminal/verify.ts` §15 asserted the refusal ("exactly as /ws is"). The web
already sends `?token=` from `VITE_CONDUCTOR_TOKEN` on both sockets (`web/src/lib/feed.ts:87-89`,
`web/src/agent/term.ts:41-45`); nothing there changes.

- **The two sockets are checked by `?token=`.** In the bearer hook, a request with
  `Upgrade: websocket` whose path is `WS_PATH` or starts with `/ws/term/` (`isBrowserSocket`) is let
  through on a `?token=` equal to the token, and on nothing else: no token, a wrong one, or only a
  bearer header is 401, answered on the raw socket and ended, as the guard's 403 is, so a refused
  upgrade cannot hold `app.close()` open.
- **Constant time.** The token is compared with `crypto.timingSafeEqual` (`isToken`), a different
  length refused before comparing. The bearer header and the websocket `verifyClient` use it too.
- **Unchanged:** the localhost Host/Origin guard (`guard.ts:41`) runs first, so a foreign Origin is
  403 whatever its token; every other request, including a plain GET to `/ws` or `/api/...` carrying
  `?token=`, still needs the bearer header; `/preview/` is still exempt.

**Verified:** `terminal/verify.ts` §15, against a daemon started with a token (21 checks): for the
feed and the terminal socket, `?token=` alone connects, and from a local Origin; no token, a bearer
header without `?token=`, a wrong token of the same length, a shorter or longer one, and a foreign
Origin with the right token are each refused; a plain HTTP request with `?token=` is 401, with the
bearer header 200, with a wrong one 401. Against the old hook, the four "connects" checks fail.

## MANUAL

Existing text (docs/MANUAL.md:167, the environment-variable table):

```
| `CONDUCTOR_TOKEN` | Makes the daemon require this token on every request. The web app sends it when `VITE_CONDUCTOR_TOKEN` is set to the same value. |
```

Replacement:

```
| `CONDUCTOR_TOKEN` | Makes the daemon require this token on every request. The web app sends it when `VITE_CONDUCTOR_TOKEN` is set to the same value: as an `Authorization: Bearer` header on HTTP requests, and as `?token=` on the feed and terminal sockets, since a browser cannot set a header on a WebSocket. |
```
