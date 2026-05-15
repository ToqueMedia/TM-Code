#!/usr/bin/env bash
#
# End-to-end smoke test for the react-express-prisma-auth template.
#
# What this validates:
#   1. The template scaffolds without missing files.
#   2. `npm install` succeeds (deps versions are resolvable).
#   3. The predev hook creates the SQLite DB + migrations idempotently.
#   4. `npm run dev` starts both servers without crashing on missing env.
#   5. The Vite proxy forwards /api/* to the backend (Bug #1 from the
#      BugHunterKimi session — proxy wasn't wired).
#   6. /api/auth/me returns 401 JSON, NOT 404 HTML (proves proxy + route mounted).
#   7. /api/auth/proxy/google with bogus token returns 401 with mapped error
#      (proves tenantId is being sent — without it, ITK returns 400 INVALID
#      and the fallthrough would be 502).
#   8. The "missing env" guard fires before the server accepts requests.
#
# Run: bash tests/templates/test-react-express-prisma-auth.sh
#
# Failure exit codes are intentional — CI should parse them.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/src-tauri/resources/templates/react-express-prisma-auth"
TMP_DIR="$(mktemp -d -t tm-template-test-XXXXXX)"
LOG_DIR="$TMP_DIR/logs"
mkdir -p "$LOG_DIR"

# Use non-default ports to avoid colliding with anything the developer is
# running (5173 / 3001 are extremely common). FRONTEND_PORT is overwritten
# below from Vite's actual log output — the template doesn't pin a port,
# so we just observe what Vite picked.
FRONTEND_PORT=""
BACKEND_PORT=3101
GUARD_PORT=33999
ITK_MOCK_PORT=44991

DEV_PID=""
ITK_MOCK_PID=""
PASS=0
FAIL=0

color() {
  case "$1" in
    green) printf "\033[0;32m%s\033[0m" "$2" ;;
    red)   printf "\033[0;31m%s\033[0m" "$2" ;;
    yellow) printf "\033[0;33m%s\033[0m" "$2" ;;
    *)     printf "%s" "$2" ;;
  esac
}

step() {
  echo
  echo "▶ $(color yellow "$1")"
}

pass() {
  echo "  $(color green "✓") $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  $(color red "✗") $1"
  FAIL=$((FAIL + 1))
}

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    # Kill the whole process group so concurrently's children also die.
    kill -TERM -"$DEV_PID" 2>/dev/null || true
    sleep 1
    kill -KILL -"$DEV_PID" 2>/dev/null || true
  fi
  if [[ -n "$ITK_MOCK_PID" ]] && kill -0 "$ITK_MOCK_PID" 2>/dev/null; then
    kill -9 "$ITK_MOCK_PID" 2>/dev/null || true
  fi
  # Free any lingering port binds (concurrently sometimes orphans children).
  if [[ -n "$FRONTEND_PORT" ]]; then
    lsof -ti:$FRONTEND_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi
  lsof -ti:$BACKEND_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti:$GUARD_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  lsof -ti:$ITK_MOCK_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
  if [[ "${KEEP_TMP:-}" == "1" ]]; then
    echo
    echo "Tmp dir kept at: $TMP_DIR"
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

echo "=== react-express-prisma-auth template e2e ==="
echo "tmp:      $TMP_DIR"
echo "template: $TEMPLATE_DIR"

# ─────────────────────────────────────────────────────────────────
step "1. Copy template to tmp dir"
# ─────────────────────────────────────────────────────────────────
PROJECT_DIR="$TMP_DIR/sample-project"
mkdir -p "$PROJECT_DIR"
cp -R "$TEMPLATE_DIR/." "$PROJECT_DIR/"

# Mirror the dotfile rename the Rust scaffold_template performs at runtime.
# Source files use _gitignore / _env.example because Tauri's bundler glob
# excludes dotfiles. The Rust scaffold restores the dot at copy time; here
# we replicate that so the test exercises the same on-disk shape the user
# would see after scaffold.
[[ -f "$PROJECT_DIR/_gitignore" ]] && mv "$PROJECT_DIR/_gitignore" "$PROJECT_DIR/.gitignore"
[[ -f "$PROJECT_DIR/_env.example" ]] && mv "$PROJECT_DIR/_env.example" "$PROJECT_DIR/.env.example"

# Required files must exist.
required_files=(
  "package.json"
  "scripts/db-setup.mjs"
  "prisma/schema.prisma"
  ".env.example"
  ".gitignore"
  "server/package.json"
  "server/src/index.ts"
  "server/src/lib/prisma.ts"
  "server/src/middleware/auth.ts"
  "server/src/routes/auth.ts"
  "client/package.json"
  "client/vite.config.ts"
  "client/index.html"
  "client/src/main.tsx"
  "client/src/lib/firebase.ts"
  "client/src/lib/authClient.ts"
  "client/src/lib/useGoogleSignIn.ts"
  "client/src/store/authStore.ts"
)
missing=0
for f in "${required_files[@]}"; do
  if [[ ! -f "$PROJECT_DIR/$f" ]]; then
    fail "missing file: $f"
    missing=$((missing + 1))
  fi
done
if [[ $missing -eq 0 ]]; then
  pass "all ${#required_files[@]} required files present"
fi

# ─────────────────────────────────────────────────────────────────
step "2. Write a test .env (mimics provision_auth output)"
# ─────────────────────────────────────────────────────────────────
# We use OBVIOUSLY-INVALID values for the API keys — Identity Toolkit will
# reject them, which is the EXPECTED behaviour for the smoke test (it proves
# the env reached the route code and the request was made; not that the
# Google API accepts them).
cat > "$PROJECT_DIR/.env" <<EOF
VITE_FIREBASE_API_KEY=test-api-key-not-real
VITE_FIREBASE_AUTH_DOMAIN=test.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=test-project
VITE_GIP_TENANT_ID=test-tenant-id
VITE_GOOGLE_CLIENT_ID=test-client-id.apps.googleusercontent.com
GIP_FIREBASE_API_KEY=test-api-key-not-real
GIP_TENANT_ID=test-tenant-id
GCP_PROJECT_ID=test-project
PORT=$BACKEND_PORT
ITK_BASE_URL_OVERRIDE=http://127.0.0.1:$ITK_MOCK_PORT/v1
EOF
pass ".env written (with ITK mock override)"

# ─────────────────────────────────────────────────────────────────
step "3. Install deps (npm install at root + workspaces)"
# ─────────────────────────────────────────────────────────────────
cd "$PROJECT_DIR"
if npm install --no-audit --no-fund --loglevel=error >"$LOG_DIR/install.log" 2>&1; then
  pass "npm install succeeded"
else
  fail "npm install failed — see $LOG_DIR/install.log"
  echo "─── tail ──────────────────"
  tail -n 30 "$LOG_DIR/install.log"
  echo "───────────────────────────"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────
step "4. predev hook runs db-setup.mjs (creates schema)"
# ─────────────────────────────────────────────────────────────────
if node scripts/db-setup.mjs >"$LOG_DIR/db-setup.log" 2>&1; then
  pass "db-setup.mjs exited 0"
else
  fail "db-setup.mjs failed — see $LOG_DIR/db-setup.log"
  tail -n 30 "$LOG_DIR/db-setup.log"
  exit 1
fi

if [[ -s "$PROJECT_DIR/prisma/dev.db" ]]; then
  pass "prisma/dev.db exists and is non-empty"
else
  fail "prisma/dev.db is missing or 0 bytes (Bug #6 from BugHunterKimi reproducible)"
fi

# Re-running the script must be idempotent.
if node scripts/db-setup.mjs >"$LOG_DIR/db-setup-2.log" 2>&1; then
  pass "db-setup.mjs is idempotent (second run also exited 0)"
else
  fail "db-setup.mjs not idempotent — see $LOG_DIR/db-setup-2.log"
fi

# ─────────────────────────────────────────────────────────────────
step "5. Boot dev server in background"
# ─────────────────────────────────────────────────────────────────
# Override the Vite port so the test's port choice wins, and explicitly
# point the proxy at the backend port we set. We do this by writing a
# small vite.config patch override via VITE_DEV_PORT (read by the test
# proxy below — we patch vite.config.ts in place for this run only).
# Simpler: just patch the proxy target + frontend port at the file level.
# This is the test's job, not the template's.
sed -i.bak \
  -e "s#http://localhost:3001#http://localhost:$BACKEND_PORT#g" \
  client/vite.config.ts
echo "  (test patched vite.config proxy → :$BACKEND_PORT)"

# Boot the local Identity Toolkit mock so the auth proxy never reaches
# google.com — keeps the test fully offline + deterministic. The mock's
# port MUST match the override in the .env we wrote earlier (44991).
ITK_MOCK_PORT=$ITK_MOCK_PORT node "$ROOT_DIR/tests/templates/itk-mock.mjs" >"$LOG_DIR/itk-mock.log" 2>&1 &
ITK_MOCK_PID=$!
# Wait until the mock is actually listening (avoid race between npm run dev
# and the mock's first request). Poll for the listening line specifically.
for i in $(seq 1 30); do
  if grep -q "listening on http://127.0.0.1:$ITK_MOCK_PORT" "$LOG_DIR/itk-mock.log" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if ! grep -q "listening on http://127.0.0.1:$ITK_MOCK_PORT" "$LOG_DIR/itk-mock.log" 2>/dev/null; then
  fail "ITK mock failed to bind on :$ITK_MOCK_PORT"
  cat "$LOG_DIR/itk-mock.log"
  exit 1
fi

# Start in its own process group so we can kill the whole tree.
set -m
( npm run dev >"$LOG_DIR/dev.log" 2>&1 ) &
DEV_PID=$!
set +m

# Wait up to 60s for both servers to print "ready" lines.
echo -n "  waiting for servers"
ready=0
for i in $(seq 1 60); do
  if grep -q "listening on http://localhost:$BACKEND_PORT" "$LOG_DIR/dev.log" 2>/dev/null \
     && grep -qE "Local:.*http://localhost:[0-9]+" "$LOG_DIR/dev.log" 2>/dev/null; then
    ready=1
    break
  fi
  echo -n "."
  sleep 1
done
echo

if [[ $ready -eq 1 ]]; then
  pass "both servers reported ready"
else
  fail "dev servers did not start within 60s"
  echo "─── dev.log (last 60 lines) ──────────"
  tail -n 60 "$LOG_DIR/dev.log"
  echo "──────────────────────────────────────"
  exit 1
fi

# Discover the port Vite actually picked. The template doesn't pin a port so
# Vite uses 5173 unless busy, in which case it climbs to 5174, 5175, etc.
# Strip any trailing slashes/whitespace from the captured port.
FRONTEND_PORT=$(grep -oE "Local:[[:space:]]+http://localhost:[0-9]+" "$LOG_DIR/dev.log" | head -n1 | grep -oE "[0-9]+$")
if [[ -z "$FRONTEND_PORT" ]]; then
  fail "could not detect Vite port from dev.log"
  exit 1
else
  pass "Vite is listening on :$FRONTEND_PORT"
fi

# ─────────────────────────────────────────────────────────────────
step "6. Backend /health responds"
# ─────────────────────────────────────────────────────────────────
health_status=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$BACKEND_PORT/health" || echo "000")
if [[ "$health_status" == "200" ]]; then
  pass "/health → 200"
else
  fail "/health → $health_status (expected 200)"
fi

# ─────────────────────────────────────────────────────────────────
step "7. Vite proxy forwards /api to backend (Bug #1 — wasn't wired)"
# ─────────────────────────────────────────────────────────────────
# Hit the FRONTEND port. Without the vite.config proxy this returns 404
# HTML because Vite's dev server doesn't know /api routes exist.
# Need to wait for Vite to actually be ready to serve.
vite_ready=0
for i in $(seq 1 30); do
  vstatus=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$FRONTEND_PORT/" || echo "000")
  if [[ "$vstatus" == "200" ]]; then
    vite_ready=1
    break
  fi
  sleep 1
done
if [[ $vite_ready -ne 1 ]]; then
  fail "Vite never served the index — check that --host 0.0.0.0 is in client/package.json dev script"
else
  proxied_status=$(curl -s -o "$LOG_DIR/proxied-me.body" -w '%{http_code}' "http://localhost:$FRONTEND_PORT/api/auth/me" || echo "000")
  proxied_ct=$(curl -sI "http://localhost:$FRONTEND_PORT/api/auth/me" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type" { print $2 }' | head -n1)
  if [[ "$proxied_status" == "401" && "$proxied_ct" == application/json* ]]; then
    pass "/api/auth/me via Vite proxy → 401 JSON (proxy wired, route mounted)"
  else
    fail "/api/auth/me via Vite proxy → status=$proxied_status, content-type=$proxied_ct"
    echo "    body: $(head -c 200 "$LOG_DIR/proxied-me.body" 2>/dev/null || echo '<empty>')"
  fi
fi

# ─────────────────────────────────────────────────────────────────
step "8. /api/auth/me direct → 401 JSON (route mounted, JWT check works)"
# ─────────────────────────────────────────────────────────────────
direct_status=$(curl -s -o "$LOG_DIR/direct-me.body" -w '%{http_code}' "http://localhost:$BACKEND_PORT/api/auth/me" || echo "000")
direct_ct=$(curl -sI "http://localhost:$BACKEND_PORT/api/auth/me" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type" { print $2 }' | head -n1)
if [[ "$direct_status" == "401" && "$direct_ct" == application/json* ]]; then
  pass "/api/auth/me direct → 401 JSON"
else
  fail "/api/auth/me direct → status=$direct_status, content-type=$direct_ct"
fi

# ─────────────────────────────────────────────────────────────────
step "9. /api/auth/proxy/google with bogus token (Bug #2 — tenantId)"
# ─────────────────────────────────────────────────────────────────
# A real Google ID token is required for ITK to succeed. With a bogus token
# AND tenantId present, ITK returns 400 with an error code we map to 401.
# If tenantId were missing (the bug), the response shape changes — different
# error code, fallthrough to 502.
google_status=$(curl -s -o "$LOG_DIR/google.body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"idToken":"bogus.token.value"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/google" || echo "000")
if [[ "$google_status" =~ ^4 ]] || [[ "$google_status" =~ ^5 ]]; then
  if [[ "$google_status" == "401" ]] || [[ "$google_status" == "400" ]]; then
    pass "/api/auth/proxy/google bogus → $google_status (route reached, ITK error mapped)"
  else
    fail "/api/auth/proxy/google bogus → $google_status (expected 400 or 401)"
    echo "    body: $(head -c 300 "$LOG_DIR/google.body" 2>/dev/null || echo '<empty>')"
  fi
else
  fail "/api/auth/proxy/google bogus → $google_status (expected 400/401, got success?)"
fi

# Body should be JSON with an error field.
if grep -q '"error"' "$LOG_DIR/google.body" 2>/dev/null; then
  pass "google response has \"error\" field (JSON, not HTML)"
else
  fail "google response missing \"error\" field — likely returning HTML"
  head -c 300 "$LOG_DIR/google.body" 2>/dev/null || echo '<empty>'
fi

# ─────────────────────────────────────────────────────────────────
step "10. /api/auth/proxy/google missing body → 400 (validation)"
# ─────────────────────────────────────────────────────────────────
val_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/google" || echo "000")
if [[ "$val_status" == "400" ]]; then
  pass "missing idToken → 400"
else
  fail "missing idToken → $val_status (expected 400)"
fi

# ─────────────────────────────────────────────────────────────────
step "11. /api/auth/proxy/signup happy-path (mock ITK returns 200)"
# ─────────────────────────────────────────────────────────────────
# The ITK mock returns 200 for /accounts:signUp when tenantId is present —
# proves the signup route reaches ITK with the right shape and the response
# is forwarded as JSON to the client.
signup_body_file="$LOG_DIR/signup.body"
signup_status=$(curl -s -o "$signup_body_file" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"hunter2hunter2","name":"Alice"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signup" || echo "000")
if [[ "$signup_status" == "200" ]]; then
  pass "/api/auth/proxy/signup → 200"
else
  fail "/api/auth/proxy/signup → $signup_status (expected 200)"
  echo "    body: $(head -c 300 "$signup_body_file" 2>/dev/null || echo '<empty>')"
fi
if grep -q '"idToken"' "$signup_body_file" 2>/dev/null \
   && grep -q '"refreshToken"' "$signup_body_file" 2>/dev/null; then
  pass "signup body has idToken + refreshToken (token exchange wired)"
else
  fail "signup body missing idToken/refreshToken"
  echo "    body: $(head -c 300 "$signup_body_file" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "12. /api/auth/proxy/signup missing fields → 400 (validation)"
# ─────────────────────────────────────────────────────────────────
signup_val_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signup" || echo "000")
if [[ "$signup_val_status" == "400" ]]; then
  pass "signup without password → 400"
else
  fail "signup without password → $signup_val_status (expected 400)"
fi

# ─────────────────────────────────────────────────────────────────
step "13. /api/auth/proxy/signin invalid creds → 401 with error code mapped"
# ─────────────────────────────────────────────────────────────────
# The ITK mock returns 401 INVALID_LOGIN_CREDENTIALS for any signInWithPassword
# call with tenantId — exactly what would happen with a wrong-password attempt
# against the real ITK. Proves: route reached ITK, tenantId sent, ITK error
# mapped to a sensible HTTP status and JSON-shaped body.
signin_body_file="$LOG_DIR/signin.body"
signin_status=$(curl -s -o "$signin_body_file" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"wrongpass"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signin" || echo "000")
if [[ "$signin_status" == "401" ]]; then
  pass "/api/auth/proxy/signin invalid creds → 401"
else
  fail "/api/auth/proxy/signin invalid creds → $signin_status (expected 401)"
  echo "    body: $(head -c 300 "$signin_body_file" 2>/dev/null || echo '<empty>')"
fi
if grep -q '"error"' "$signin_body_file" 2>/dev/null; then
  pass "signin response has \"error\" field (JSON, not HTML)"
else
  fail "signin response missing \"error\" field — likely HTML or empty"
  head -c 300 "$signin_body_file" 2>/dev/null || echo '<empty>'
fi

# ─────────────────────────────────────────────────────────────────
step "14. Signup via Vite proxy (frontend → backend hop)"
# ─────────────────────────────────────────────────────────────────
# Hit the FRONTEND port. Without the vite.config proxy this fails with 404 HTML.
proxied_signup_file="$LOG_DIR/proxied-signup.body"
proxied_signup_status=$(curl -s -o "$proxied_signup_file" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@example.com","password":"correcthorsebatterystaple","name":"Bob"}' \
  -X POST "http://localhost:$FRONTEND_PORT/api/auth/proxy/signup" || echo "000")
if [[ "$proxied_signup_status" == "200" ]]; then
  pass "signup via Vite proxy → 200 (frontend → backend wiring complete)"
else
  fail "signup via Vite proxy → $proxied_signup_status (expected 200)"
  echo "    body: $(head -c 300 "$proxied_signup_file" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "15. Signin via Vite proxy → 401 JSON (full frontend → backend → ITK chain)"
# ─────────────────────────────────────────────────────────────────
proxied_signin_file="$LOG_DIR/proxied-signin.body"
# Capture status + content-type in a single request — running `curl -sI -X POST`
# afterwards is unreliable (HEAD vs POST mixing) and the second call would also
# burn a slot in the credential rate limiter.
proxied_signin_meta=$(curl -s -o "$proxied_signin_file" -w '%{http_code}|%{content_type}' \
  -H "Content-Type: application/json" \
  -d '{"email":"bob@example.com","password":"wrongpass"}' \
  -X POST "http://localhost:$FRONTEND_PORT/api/auth/proxy/signin" || echo "000|")
proxied_signin_status="${proxied_signin_meta%%|*}"
proxied_signin_ct="${proxied_signin_meta#*|}"
if [[ "$proxied_signin_status" == "401" && "$proxied_signin_ct" == application/json* ]]; then
  pass "signin via Vite proxy → 401 JSON (full chain works)"
else
  fail "signin via Vite proxy → status=$proxied_signin_status, content-type=$proxied_signin_ct"
  echo "    body: $(head -c 300 "$proxied_signin_file" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "16. Config errors are NOT disguised as 401 (mapItkError → 503)"
# ─────────────────────────────────────────────────────────────────
# When ITK returns a config-class error (API_KEY_INVALID, CONFIGURATION_NOT_FOUND,
# TENANT_ID_MISMATCH), the backend MUST return 503 with a diagnostic message —
# not 401 "Invalid email or password". This was the root cause of recurring
# 401 debugging dead-ends in production: a misconfigured .env looked identical
# to a wrong password.

# 16a. API_KEY_INVALID via signin email trigger
apikey_body="$LOG_DIR/apikey.body"
apikey_meta=$(curl -s -o "$apikey_body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"error.api-key-invalid@test","password":"any"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signin" || echo "000")
if [[ "$apikey_meta" == "503" ]] && grep -qi "api key" "$apikey_body" 2>/dev/null; then
  pass "API_KEY_INVALID → 503 with diagnostic message (not disguised as 401)"
else
  fail "API_KEY_INVALID → status=$apikey_meta (expected 503 with 'API key' in body)"
  echo "    body: $(head -c 300 "$apikey_body" 2>/dev/null || echo '<empty>')"
fi

# 16b. CONFIGURATION_NOT_FOUND via signin email trigger
confnf_body="$LOG_DIR/confnf.body"
confnf_meta=$(curl -s -o "$confnf_body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"error.config-not-found@test","password":"any"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signin" || echo "000")
if [[ "$confnf_meta" == "503" ]] && grep -qi "provider not enabled" "$confnf_body" 2>/dev/null; then
  pass "CONFIGURATION_NOT_FOUND → 503 with diagnostic message"
else
  fail "CONFIGURATION_NOT_FOUND → status=$confnf_meta (expected 503)"
  echo "    body: $(head -c 300 "$confnf_body" 2>/dev/null || echo '<empty>')"
fi

# 16c. TENANT_ID_MISMATCH via signup email trigger
tenmis_body="$LOG_DIR/tenmis.body"
tenmis_meta=$(curl -s -o "$tenmis_body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"email":"error.tenant-mismatch@test","password":"valid-password"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/signup" || echo "000")
if [[ "$tenmis_meta" == "503" ]] && grep -qi "tenant mismatch" "$tenmis_body" 2>/dev/null; then
  pass "TENANT_ID_MISMATCH → 503 with diagnostic message"
else
  fail "TENANT_ID_MISMATCH → status=$tenmis_meta (expected 503)"
  echo "    body: $(head -c 300 "$tenmis_body" 2>/dev/null || echo '<empty>')"
fi

# 16d. API_KEY_INVALID via google flow
gkey_body="$LOG_DIR/gkey.body"
gkey_meta=$(curl -s -o "$gkey_body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -d '{"idToken":"__api_key_invalid__"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/proxy/google" || echo "000")
if [[ "$gkey_meta" == "503" ]]; then
  pass "Google flow: API_KEY_INVALID → 503 (not disguised as 401)"
else
  fail "Google flow: API_KEY_INVALID → status=$gkey_meta (expected 503)"
  echo "    body: $(head -c 300 "$gkey_body" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "17. /api/auth/sync with valid JWT — exercises Prisma path (Fix D)"
# ─────────────────────────────────────────────────────────────────
# Craft a JWT that the dev middleware (decodeJwt, no signature verification)
# will accept. Required payload fields per middleware/auth.ts:
#   - sub, email (else returns null → 401)
#   - firebase.tenant === GIP_TENANT_ID (else returns null → 401)
# Signature can be anything in dev. This bypass is acceptable for tests; in
# production NODE_ENV=production triggers jwtVerify against the GIP JWKS.
b64url() { printf '%s' "$1" | openssl base64 -A | tr '/+' '_-' | tr -d '='; }
JWT_HEADER='{"alg":"none","typ":"JWT"}'
JWT_NOW=$(date +%s)
JWT_EXP=$((JWT_NOW + 3600))
JWT_PAYLOAD="{\"sub\":\"test-uid-alice\",\"email\":\"alice@example.com\",\"name\":\"Alice Tester\",\"picture\":\"https://example.com/a.png\",\"firebase\":{\"tenant\":\"test-tenant-id\"},\"iat\":$JWT_NOW,\"exp\":$JWT_EXP}"
JWT="$(b64url "$JWT_HEADER").$(b64url "$JWT_PAYLOAD").fake-signature"

sync_body="$LOG_DIR/sync.body"
sync_status=$(curl -s -o "$sync_body" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"name":"Alice Tester"}' \
  -X POST "http://localhost:$BACKEND_PORT/api/auth/sync" || echo "000")

# 200 here proves: (a) middleware decoded the JWT, (b) tenant check passed,
# (c) Prisma connected to the SAME file db-setup.mjs migrated — i.e. Fix D's
# deterministic DATABASE_URL resolution is working. Without Fix D, this returns
# 500 (Prisma init error) or 503 (P2021 if .env had a relative DATABASE_URL).
if [[ "$sync_status" == "200" ]]; then
  pass "/api/auth/sync → 200 (Prisma upsert succeeded — Fix D verified)"
else
  fail "/api/auth/sync → $sync_status (expected 200)"
  echo "    body: $(head -c 300 "$sync_body" 2>/dev/null || echo '<empty>')"
fi

if grep -q '"uid":"test-uid-alice"' "$sync_body" 2>/dev/null \
   && grep -q '"email":"alice@example.com"' "$sync_body" 2>/dev/null; then
  pass "sync response has correct uid + email (JWT claims propagated)"
else
  fail "sync response missing expected uid/email"
  echo "    body: $(head -c 300 "$sync_body" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "18. /api/auth/me with same JWT — reads back the upserted row"
# ─────────────────────────────────────────────────────────────────
# Closes the loop: same JWT, GET /me, returns the row written by /sync. Proves
# the user persisted across requests (i.e. Prisma is committing, not just
# echoing the JWT back) and that verifyAuth + lookup-by-uid both work.
me_body="$LOG_DIR/me-auth.body"
me_status=$(curl -s -o "$me_body" -w '%{http_code}' \
  -H "Authorization: Bearer $JWT" \
  "http://localhost:$BACKEND_PORT/api/auth/me" || echo "000")

if [[ "$me_status" == "200" ]]; then
  pass "/api/auth/me with JWT → 200"
else
  fail "/api/auth/me with JWT → $me_status (expected 200)"
  echo "    body: $(head -c 300 "$me_body" 2>/dev/null || echo '<empty>')"
fi

if grep -q '"uid":"test-uid-alice"' "$me_body" 2>/dev/null \
   && grep -q '"name":"Alice Tester"' "$me_body" 2>/dev/null; then
  pass "/me returned the row persisted by /sync (full Prisma round-trip)"
else
  fail "/me did not return the synced row"
  echo "    body: $(head -c 300 "$me_body" 2>/dev/null || echo '<empty>')"
fi

# ─────────────────────────────────────────────────────────────────
step "19. /api/auth/me with wrong-tenant JWT → 401 (tenant guard works)"
# ─────────────────────────────────────────────────────────────────
# Same JWT shape but with the wrong firebase.tenant. Middleware MUST reject
# even though sub/email are valid — this is the cross-tenant isolation check.
WRONG_PAYLOAD="{\"sub\":\"test-uid-alice\",\"email\":\"alice@example.com\",\"firebase\":{\"tenant\":\"different-tenant\"},\"iat\":$JWT_NOW,\"exp\":$JWT_EXP}"
WRONG_JWT="$(b64url "$JWT_HEADER").$(b64url "$WRONG_PAYLOAD").fake-signature"

wrong_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $WRONG_JWT" \
  "http://localhost:$BACKEND_PORT/api/auth/me" || echo "000")
if [[ "$wrong_status" == "401" ]]; then
  pass "/me with wrong-tenant JWT → 401 (tenant guard rejects cross-tenant access)"
else
  fail "/me with wrong-tenant JWT → $wrong_status (expected 401)"
fi

# ─────────────────────────────────────────────────────────────────
step "20. Fail-fast guard: server with missing GIP env exits non-zero"
# ─────────────────────────────────────────────────────────────────
# Tricky: @prisma/client auto-loads .env from parent dirs on import. So the
# guard test MUST hide the .env file — otherwise Prisma rescues the env
# vars before our guard at the top of index.ts even runs. (This also
# documents why production behaviour is correct: if a .env IS present,
# Prisma loads it, app starts, guard never needs to fire.)
GUARD_DIR="$TMP_DIR/guard-project"
mkdir -p "$GUARD_DIR"
cp -R "$PROJECT_DIR/." "$GUARD_DIR/"
rm -f "$GUARD_DIR/.env"

cd "$GUARD_DIR/server"
# Run with manual timeout: spawn in background, sleep, kill. Capture output
# via a file because $(...) blocks on the child even after kill.
guard_log="$LOG_DIR/guard.log"
(
  unset GIP_FIREBASE_API_KEY GIP_TENANT_ID GCP_PROJECT_ID
  unset VITE_FIREBASE_API_KEY VITE_GIP_TENANT_ID VITE_FIREBASE_PROJECT_ID
  unset PORT
  npx tsx src/index.ts > "$guard_log" 2>&1
) &
guard_pid=$!
sleep 4
if kill -0 $guard_pid 2>/dev/null; then
  kill -9 $guard_pid 2>/dev/null || true
  wait $guard_pid 2>/dev/null || true
fi

if grep -q "Missing env: GIP_" "$guard_log" 2>/dev/null; then
  pass "fail-fast guard fires when GIP_* env missing"
else
  fail "fail-fast guard did not fire — server may bind without env"
  echo "    output (first 600 chars):"
  head -c 600 "$guard_log" 2>/dev/null
  echo
fi
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────────
step "21. Restore vite.config (undo test patch)"
# ─────────────────────────────────────────────────────────────────
mv client/vite.config.ts.bak client/vite.config.ts 2>/dev/null && pass "vite.config restored" || true

echo
echo "=================================="
echo "Results: $(color green "$PASS passed"), $(color red "$FAIL failed")"
echo "=================================="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
