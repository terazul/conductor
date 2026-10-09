.DEFAULT_GOAL := help
.PHONY: help init install dock undock start stop restart status browser logs fixture attention test clean manual zip

# Conductor — process control.
#
# The one trap this encodes: the daemon binds 127.0.0.1 while Vite binds ::1
# only. So the app is at http://localhost:5173 and NOT at http://127.0.0.1:5173,
# which refuses the connection and looks exactly like a crash. `status` probes
# each on the family it actually answers on.

DAEMON_PORT ?= 7777
WEB_PORT    ?= 5173
RUN         := .conductor/run
DAEMON_LOG  := $(RUN)/daemon.log
WEB_LOG     := $(RUN)/web.log
DAEMON_PID  := $(RUN)/daemon.pid
WEB_PID     := $(RUN)/web.pid
URL         := http://localhost:$(WEB_PORT)
# make install DOCK=no leaves the dock alone.
DOCK        ?= yes

help:
	@echo ''
	@echo '  Conductor'
	@echo ''
	@echo '  make init       first-time setup: check node, pnpm and claude, then make install'
	@echo '  make start      start daemon + web, wait until both answer'
	@echo '  make status     what is running, health, live jobs and agents'
	@echo '  make browser    open the app (start it first if needed)'
	@echo '  make stop       stop both'
	@echo '  make restart    stop then start'
	@echo ''
	@echo '  make fixture    web only, replaying a recorded session — no daemon, no cost'
	@echo '  make attention  web only, replaying the attention queue'
	@echo '  make logs       tail both logs'
	@echo '  make test       every suite'
	@echo '  make clean      stop, then delete the db and logs'
	@echo ''
	@echo '  make zip        zip the project as committed, into dist/'
	@echo '  make manual     open the user manual'
	@echo '  make dock       put Conductor on the dock (macOS, Ubuntu) — make install does it too'
	@echo '  make undock     take it off again'
	@echo ''
	@echo "  app: $(URL)   (localhost, NOT 127.0.0.1 — Vite binds ::1 only)"
	@echo ''

# A zip of the project as committed (HEAD): git archive leaves out node_modules, the
# databases, logs and worktrees, because none of them are tracked. Uncommitted changes are
# left out too, and it says so. ZIP=path/name.zip puts it somewhere else.
ZIP ?= dist/conductor-$(shell date +%Y-%m-%d)-$(shell git rev-parse --short HEAD 2>/dev/null).zip

zip:
	@mkdir -p $(dir $(ZIP))
	@if [ -n "$$(git status --porcelain)" ]; then echo 'note: uncommitted changes are not in the zip; commit them first to include them'; fi
	@git archive --format=zip --prefix=conductor/ -o $(ZIP) HEAD
	@echo "zipped $$(git rev-parse --short HEAD) ($$(git rev-parse --abbrev-ref HEAD)) → $(ZIP), $$(du -h $(ZIP) | cut -f1 | tr -d ' ')"

# First-time setup: fail early on a missing node or pnpm, warn on a missing claude (the
# fixtures still work without it), then do the normal install. DOCK=no passes through.
init:
	@command -v node >/dev/null 2>&1 || { echo 'init: node not found (need 22+)'; exit 1; }
	@node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "init: node $$(node -v) is too old (need 22+)"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo 'init: pnpm not found (need 10+)'; exit 1; }
	@[ "$$(pnpm -v | cut -d. -f1)" -ge 10 ] || { echo "init: pnpm $$(pnpm -v) is too old (need 10+)"; exit 1; }
	@command -v claude >/dev/null 2>&1 || echo 'init: warning — claude CLI not found; real agents cannot run until it is installed and logged in'
	@$(MAKE) install DOCK=$(DOCK)
	@echo ''
	@echo '  installed. next: make start && make browser'
	@echo ''

install:
	pnpm install
	@if [ '$(DOCK)' != no ]; then sh scripts/dock.sh install || echo 'dock: skipped — make dock to try again'; fi

# The icon starts Conductor if it isn't up, then opens it. See scripts/launch.sh.
dock:
	@sh scripts/dock.sh install

undock:
	@sh scripts/dock.sh remove

manual:
	@open docs/MANUAL.md 2>/dev/null || xdg-open docs/MANUAL.md 2>/dev/null || echo 'docs/MANUAL.md'

$(RUN):
	@mkdir -p $(RUN)

start: $(RUN)
	@if [ -s $(DAEMON_PID) ] && kill -0 $$(cat $(DAEMON_PID)) 2>/dev/null; then \
		echo 'daemon already running (make restart to bounce it)'; \
	else \
		echo 'starting daemon...'; \
		pnpm --filter @conductor/daemon start > $(DAEMON_LOG) 2>&1 & echo $$! > $(DAEMON_PID); \
	fi
	@if [ -s $(WEB_PID) ] && kill -0 $$(cat $(WEB_PID)) 2>/dev/null; then \
		echo 'web already running'; \
	else \
		echo 'starting web...'; \
		pnpm --filter @conductor/web dev > $(WEB_LOG) 2>&1 & echo $$! > $(WEB_PID); \
	fi
	@printf 'waiting for daemon '
	@for i in $$(seq 1 40); do \
		if curl -fsS -o /dev/null --max-time 1 http://127.0.0.1:$(DAEMON_PORT)/api/health 2>/dev/null; then \
			echo ' up'; break; \
		fi; \
		printf '.'; sleep 0.5; \
		if [ $$i -eq 40 ]; then echo ' TIMED OUT — see make logs'; fi; \
	done
	@printf 'waiting for web    '
	@for i in $$(seq 1 40); do \
		if curl -fsS -o /dev/null --max-time 1 $(URL) 2>/dev/null; then \
			echo ' up'; break; \
		fi; \
		printf '.'; sleep 0.5; \
		if [ $$i -eq 40 ]; then echo ' TIMED OUT — see make logs'; fi; \
	done
	@echo ''
	@echo "  ready → $(URL)"
	@echo '  press 0 in the app for Diagnostics — it tells you whether the data is honest'
	@echo ''

status:
	@CONDUCTOR_PORT=$(DAEMON_PORT) WEB_PORT=$(WEB_PORT) node scripts/status.mjs
	@printf '  worktrees '
	@if [ -d .conductor/wt ]; then ls -1 .conductor/wt 2>/dev/null | wc -l | tr -d ' '; else echo 0; fi
	@echo ''

stop:
	@for f in $(DAEMON_PID) $(WEB_PID); do \
		if [ -s $$f ]; then kill $$(cat $$f) 2>/dev/null || true; rm -f $$f; fi; \
	done
	@# pnpm spawns children, and a hard kill can orphan the listener. Clear the ports —
	@# listeners only: a browser with the page open holds a socket on them too.
	@lsof -ti tcp:$(DAEMON_PORT) -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true
	@lsof -ti tcp:$(WEB_PORT) -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true
	@sleep 1
	@echo 'stopped'

restart: stop start

browser:
	@if ! curl -fsS -o /dev/null --max-time 2 $(URL) 2>/dev/null; then \
		echo 'web is not up — run make start first'; exit 1; \
	fi
	@echo "opening $(URL)"
	@open $(URL) 2>/dev/null || xdg-open $(URL) 2>/dev/null || echo "open $(URL) yourself"

logs: $(RUN)
	@touch $(DAEMON_LOG) $(WEB_LOG)
	tail -f $(DAEMON_LOG) $(WEB_LOG)

# No daemon, no API spend — replays a recorded session through the real store.
# The recorded job, plus an agent on OpenRouter that reports tokens and no dollars
# (Amendment 80). FIXTURE=session-basic replays the job alone.
FIXTURE ?= providers
fixture:
	@echo "fixture mode → $(URL)  (replaying fixtures/$(FIXTURE).jsonl)"
	VITE_FIXTURE=$(FIXTURE) pnpm --filter @conductor/web dev

attention:
	@echo "fixture mode → $(URL)  (attention queue: one parked, one held)"
	VITE_FIXTURE=permission-requests pnpm --filter @conductor/web dev

test:
	pnpm -r typecheck
	pnpm --filter @conductor/daemon smoke
	pnpm --filter @conductor/web verify
	pnpm --filter @conductor/web exec tsx src/spawn/verify.ts
	pnpm --filter @conductor/web exec tsx src/agent/verify.ts
	pnpm --filter @conductor/web exec tsx src/attention/verify.ts
	pnpm --filter @conductor/web exec tsx src/files/verify.ts
	pnpm --filter @conductor/web exec tsx src/shell/verify.ts
	pnpm --filter @conductor/web exec tsx src/lib/verify-seen-agents.ts
	pnpm --filter @conductor/web exec tsx src/lib/verify-crumb.ts
	pnpm --filter @conductor/web exec tsx src/attention/verify-needs-panel.ts
	pnpm --filter @conductor/web exec tsx src/branches/verify.ts
	pnpm --filter @conductor/web exec tsx src/lib/verify-schedule.ts
	bash fixtures/make-scratch-repo.sh
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/workspace/verify.ts
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/preview/verify.ts
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify.ts
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/workspace/verify-branches.ts
	pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-schedule.ts

# The database lives in ~/.conductor/ once you allowed it (Amendment 46); CONDUCTOR_DATA
# moves it. Settings beside it are kept, and so is the database from before the move,
# in packages/daemon/ — you chose to leave that where it is.
CONDUCTOR_DATA ?= $(HOME)/.conductor
DB ?= $(CONDUCTOR_DATA)/conductor.db

clean: stop
	@if [ -e $(DB) ]; then rm -f $(DB) $(DB)-wal $(DB)-shm; echo "removed $(DB)"; else echo "no database at $(DB)"; fi
	@rm -rf $(RUN)
	@echo 'logs removed (settings.json, and worktrees under .conductor/wt, left alone)'
