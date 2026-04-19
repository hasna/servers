#!/usr/bin/env bash
set -uo pipefail

DB="/tmp/e2e-servers-$(date +%s).db"
CLI="bun run src/cli/index.ts"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

run() {
  local desc="$1"; shift
  echo -ne "  $CYAN▶ $desc$NC ... "
  if eval "$@" > /tmp/e2e_out.txt 2>&1; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC}"
    cat /tmp/e2e_out.txt
    ((FAIL++))
  fi
}

assert_contains() {
  local desc="$1"
  local pattern="$2"
  if grep -q "$pattern" /tmp/e2e_out.txt; then
    echo -e "    ${GREEN}✓ $desc${NC}"
  else
    echo -e "    ${RED}✗ $desc (expected '$pattern')${NC}"
    cat /tmp/e2e_out.txt
  fi
}

echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Multi-Agent E2E Test — $(date -Iseconds)  ${NC}"
echo -e "${CYAN}  DB: $DB                              ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

# ── Phase 1: Project Setup ─────────────────────────────────────
echo -e "\n${YELLOW}Phase 1: Project Setup${NC}"

run "Dashboard (empty DB)" \
  "$CLI --db $DB"

run "Add project via git root" \
  "$CLI --db $DB project:add -n test-project --path /tmp/test-e2e-repo --description 'E2E test project'"

run "List projects" \
  "$CLI --db $DB projects"
assert_contains "Shows test-project" "test-project"

# ── Phase 2: Server Registration (3 servers) ────────────────────
echo -e "\n${YELLOW}Phase 2: Server Registration${NC}"

run "Add prod server" \
  "$CLI --db $DB server:add -n 'prod-us-east' --slug prod --hostname prod-01.internal --path /srv/app --description 'Production US-East'"
assert_contains "Created prod" "prod-us-east"

run "Add staging server" \
  "$CLI --db $DB server:add -n 'staging' --slug staging --hostname staging-01.internal --path /srv/app --description 'Staging environment'"

run "Add dev server" \
  "$CLI --db $DB server:add -n 'dev-box' --slug dev --hostname dev-01.internal --path /srv/app --description 'Developer box'"

run "List servers" \
  "$CLI --db $DB server"
assert_contains "Shows 3 servers" "prod-us-east"

run "Get server by slug" \
  "$CLI --db $DB server:get prod"
assert_contains "Prod details" "prod-us-east"

run "Server JSON output" \
  "$CLI --db $DB server --json"
assert_contains "JSON array" '"prod-us-east"'

# ── Phase 3: Agent Registration (3 agents simulating different roles) ──
echo -e "\n${YELLOW}Phase 3: Agent Registration${NC}"

run "Register Brutus (dev agent)" \
  "$CLI --db $DB agent:register -n brutus --description 'Code refactoring agent' --capabilities refactoring,code-review --session sess-brutus-001"
assert_contains "Registered brutus" "brutus"

run "Register Cicero (docs agent)" \
  "$CLI --db $DB agent:register -n cicero --description 'Documentation agent' --capabilities docs,writing --session sess-cicero-002"

run "Register Cato (security agent)" \
  "$CLI --db $DB agent:register -n cato --description 'Security audit agent' --capabilities security,audit --session sess-cato-003"

run "List agents" \
  "$CLI --db $DB agents"
assert_contains "Shows 3 agents" "brutus"

run "Agent JSON output" \
  "$CLI --db $DB agents --json"
assert_contains "JSON agents" '"cicero"'

# ── Phase 4: Server Heartbeats ──────────────────────────────────
echo -e "\n${YELLOW}Phase 4: Server Heartbeats${NC}"

run "Heartbeat prod" \
  "$CLI --db $DB server:heartbeat prod"
assert_contains "Prod heartbeat" "prod-us-east"

run "Heartbeat staging" \
  "$CLI --db $DB server:heartbeat staging"

# ── Phase 5: Agent Heartbeats ───────────────────────────────────
echo -e "\n${YELLOW}Phase 5: Agent Heartbeats${NC}"

run "Brutus heartbeat" \
  "$CLI --db $DB agent:heartbeat brutus"
assert_contains "Brutus heartbeat" "brutus"

run "Cicero heartbeat" \
  "$CLI --db $DB agent:heartbeat cicero"

run "Cato heartbeat" \
  "$CLI --db $DB agent:heartbeat cato"

# ── Phase 6: Operations — Brutus deploys ────────────────────────
echo -e "\n${YELLOW}Phase 6: Brutus deploys to staging${NC}"

run "Create deploy operation on staging" \
  "$CLI --db $DB operation:add --server staging --type deploy --agent brutus --session sess-brutus-001"

# Get the full op ID
OP_IDS=$($CLI --db $DB operations --json | python3 -c "import sys,json; [print(o['id']) for o in json.load(sys.stdin)]")
DEPLOY_OP=$(echo "$OP_IDS" | head -1)

run "Start deploy operation" \
  "$CLI --db $DB operation:start $DEPLOY_OP"
assert_contains "Running" "running"

run "Mark deploy as completed" \
  "$CLI --db $DB operation:complete $DEPLOY_OP"
assert_contains "Completed" "Completed"

# ── Phase 7: Operations — Cato security audit on prod ───────────
echo -e "\n${YELLOW}Phase 7: Cato audits prod${NC}"

run "Create security audit on prod" \
  "$CLI --db $DB operation:add --server prod --type custom --agent cato --session sess-cato-003"

AUDIT_OP=$($CLI --db $DB operations --json | python3 -c "import sys,json; [print(o['id']) for o in json.load(sys.stdin) if o['operation_type']=='custom']" | head -1)

run "Start security audit" \
  "$CLI --db $DB operation:start $AUDIT_OP"

# Simulate Cato finding a vulnerability
run "Mark audit as failed (vuln found)" \
  "$CLI --db $DB operation:fail $AUDIT_OP --error 'CVE-2025-XXXX: SQL injection in /api/v1/query'"
assert_contains "Failed" "failed"

# ── Phase 8: Brutus restarts staging ────────────────────────────
echo -e "\n${YELLOW}Phase 8: Brutus restarts staging after deploy${NC}"

run "Server restart command" \
  "$CLI --db $DB server:restart staging --agent brutus --session sess-brutus-001"
assert_contains "Restart" "staging"

# ── Phase 9: Cicero adds traces (audit trail) ───────────────────
echo -e "\n${YELLOW}Phase 9: Cicero documents audit traces${NC}"

run "Trace: deploy started" \
  "$CLI --db $DB trace:add --server staging --event deploy.started --agent cicero --operation $DEPLOY_OP --details '{\"by\":\"brutus\"}'"
assert_contains "Trace" "Trace created"

run "Trace: deploy completed" \
  "$CLI --db $DB trace:add --server staging --event deploy.completed --agent cicero --operation $DEPLOY_OP --details '{\"status\":\"ok\"}'"

run "Trace: security audit started" \
  "$CLI --db $DB trace:add --server prod --event security_audit.started --agent cato --operation $AUDIT_OP"

run "Trace: security audit findings" \
  "$CLI --db $DB trace:add --server prod --event security_audit.findings --agent cato --operation $AUDIT_OP --details '{\"severity\":\"high\",\"cve\":\"CVE-2025-XXXX\"}'"

run "List traces" \
  "$CLI --db $DB traces"
assert_contains "Shows traces" "deploy.started"

run "Traces JSON" \
  "$CLI --db $DB traces --json"

run "Filter traces by agent" \
  "$CLI --db $DB traces -a cato"
assert_contains "Cato traces" "cato"

# ── Phase 10: Operations listing and filtering ──────────────────
echo -e "\n${YELLOW}Phase 10: Operations overview${NC}"

run "List all operations" \
  "$CLI --db $DB operations"
assert_contains "All operations" "deploy"

run "Filter by server (prod)" \
  "$CLI --db $DB operations -s prod"

run "Filter by status (completed)" \
  "$CLI --db $DB operations --status completed"
assert_contains "Completed ops" "completed"

run "Operations JSON" \
  "$CLI --db $DB operations --json"

# ── Phase 11: Update operation ──────────────────────────────────
echo -e "\n${YELLOW}Phase 11: Operation update/delete${NC}"

# Create a new pending operation
run "Add pending operation" \
  "$CLI --db $DB operation:add --server dev --type status_check"

PENDING_OP=$($CLI --db $DB operations --json | python3 -c "import sys,json; [print(o['id']) for o in json.load(sys.stdin) if o['status']=='pending']" | head -1)

run "Cancel pending operation" \
  "$CLI --db $DB operation:cancel $PENDING_OP"
assert_contains "Cancelled" "cancelled"

run "Update operation status" \
  "$CLI --db $DB operation:update $DEPLOY_OP --status completed"

# ── Phase 12: Server update ─────────────────────────────────────
echo -e "\n${YELLOW}Phase 12: Server update${NC}"

run "Update server status to online" \
  "$CLI --db $DB server:update prod --status online --description 'Production online after fix'"
assert_contains "Updated" "prod-us-east"

run "Update staging slug" \
  "$CLI --db $DB server:update staging --slug staging-v2"

# ── Phase 13: Agent update ──────────────────────────────────────
echo -e "\n${YELLOW}Phase 13: Agent update${NC}"

run "Update Brutus description" \
  "$CLI --db $DB agent:update brutus --description 'Senior refactoring agent — handles complex migrations'"
assert_contains "Updated" "brutus"

# ── Phase 14: Webhook setup ─────────────────────────────────────
echo -e "\n${YELLOW}Phase 14: Webhook registration${NC}"

run "Add webhook for deploy events" \
  "$CLI --db $DB webhook:add --url https://hooks.example.com/deploy --events deploy.started,deploy.completed --secret mysecret"
assert_contains "Created webhook" "Created webhook"

run "Add webhook for security events" \
  "$CLI --db $DB webhook:add --url https://hooks.example.com/security --events security_audit.started,security_audit.findings"

run "List webhooks" \
  "$CLI --db $DB webhooks"
assert_contains "Shows webhooks" "hooks.example.com"

run "Webhook JSON" \
  "$CLI --db $DB webhooks --json"

run "Toggle webhook" \
  "$CLI --db $DB webhook:toggle $($CLI --db $DB webhooks --json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")"
assert_contains "Toggled" "active"

# ── Phase 15: Dashboard with data ───────────────────────────────
echo -e "\n${YELLOW}Phase 15: Dashboard (populated)${NC}"

run "Dashboard shows servers" \
  "$CLI --db $DB"
assert_contains "Shows servers" "prod-us-east"

run "Dashboard shows agents" \
  "$CLI --db $DB"
assert_contains "Shows agents" "brutus"

run "Dashboard with --format json" \
  "$CLI --db $DB --format json"
assert_contains "JSON output" '"servers"'

# ── Phase 16: Export and Import ─────────────────────────────────
echo -e "\n${YELLOW}Phase 16: Export / Import round-trip${NC}"

EXPORT_FILE="/tmp/e2e-export-$(date +%s).json"

run "Export database" \
  "$CLI --db $DB export --output $EXPORT_FILE"
assert_contains "Exported" "Exported to"

run "Verify export file exists" \
  "test -s $EXPORT_FILE"

DB2="/tmp/e2e-servers-2-$(date +%s).db"

run "Import into new database" \
  "$CLI --db $DB2 import --input $EXPORT_FILE"
assert_contains "Imported" "servers:"

run "Verify imported servers" \
  "$CLI --db $DB2 server"
assert_contains "Imported prod" "prod-us-east"

run "Verify imported agents" \
  "$CLI --db $DB2 agents"
assert_contains "Imported brutus" "brutus"

run "Verify imported operations" \
  "$CLI --db $DB2 operations"

# ── Phase 17: Delete operations ─────────────────────────────────
echo -e "\n${YELLOW}Phase 17: Cleanup operations${NC}"

run "Delete cancelled operation" \
  "$CLI --db $DB operation:delete $PENDING_OP"
assert_contains "Deleted" "Deleted operation"

# ── Phase 18: Delete traces ─────────────────────────────────────
echo -e "\n${YELLOW}Phase 18: Trace cleanup${NC}"

run "Delete traces for dev server" \
  "$CLI --db $DB traces:delete dev"
assert_contains "Deleted traces" "Deleted"

# ── Phase 19: Agent lifecycle ───────────────────────────────────
echo -e "\n${YELLOW}Phase 19: Agent archive/release${NC}"

run "Archive Cicero (docs done)" \
  "$CLI --db $DB agent:archive cicero"
assert_contains "Archived" "Archived"

run "List active agents (Cicero gone)" \
  "$CLI --db $DB agents"

run "Release Cato's locks" \
  "$CLI --db $DB agent:release cato"
assert_contains "Released" "Released"

# ── Phase 20: Server lock/unlock (multi-agent contention) ───────
echo -e "\n${YELLOW}Phase 20: Server lock contention${NC}"

run "Brutus locks staging" \
  "$CLI --db $DB server:lock staging --agent brutus"
assert_contains "Locked" "brutus"

run "Cato tries to lock staging (should fail)" \
  "$CLI --db $DB server:lock staging --agent cato" || true

run "Brutus unlocks staging" \
  "$CLI --db $DB server:unlock staging --agent brutus"
assert_contains "Unlocked" "staging"

# ── Phase 21: Server stop ───────────────────────────────────────
echo -e "\n${YELLOW}Phase 21: Server stop command${NC}"

run "Stop dev server" \
  "$CLI --db $DB server:stop dev --agent cato"
assert_contains "Stop" "dev-box"

# ── Phase 22: Completion scripts ────────────────────────────────
echo -e "\n${YELLOW}Phase 22: Shell completions${NC}"

run "Bash completions" \
  "$CLI --db $DB completion bash"
assert_contains "Complete function" "complete"

run "Zsh completions" \
  "$CLI --db $DB completion zsh"
assert_contains "Zsh compdef" "compdef"

run "Fish completions" \
  "$CLI --db $DB completion fish"
assert_contains "Fish complete" "complete -c servers"

# ── Phase 23: Webhook deliveries ────────────────────────────────
echo -e "\n${YELLOW}Phase 23: Webhook deliveries${NC}"

run "Webhook deliveries list" \
  "$CLI --db $DB webhook:deliveries"

# ── Phase 24: Final dashboard ───────────────────────────────────
echo -e "\n${YELLOW}Phase 24: Final state dashboard${NC}"

run "Final dashboard" \
  "$CLI --db $DB"

run "Final operations list" \
  "$CLI --db $DB operations"

run "Final traces list" \
  "$CLI --db $DB traces"

run "Final webhooks list" \
  "$CLI --db $DB webhooks"

# ── Phase 25: Cleanup ──────────────────────────────────────────
echo -e "\n${YELLOW}Phase 25: Cleanup${NC}"

run "Delete staging server" \
  "$CLI --db $DB server:unlock staging --agent brutus 2>/dev/null; $CLI --db $DB server:delete staging"
assert_contains "Deleted" "Deleted server"

# ── Results ─────────────────────────────────────────────────────
echo -e "\n${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}PASS: $PASS${NC}"
echo -e "${RED}FAIL: $FAIL${NC}"
echo -e "${CYAN}Total: $((PASS + FAIL)) tests${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

# Cleanup temp files
rm -f /tmp/e2e_out.txt /tmp/e2e-export-*.json
rm -f "$DB" "$DB2"

exit $FAIL
