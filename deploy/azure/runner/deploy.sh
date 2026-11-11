#!/usr/bin/env bash
# Builds the code tarball and PRINTS the Azure and ssh commands to run. It creates nothing itself.
# Usage: deploy/azure/runner/deploy.sh   (from anywhere inside the repo). UNTESTED end to end.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=${OUT:-/tmp/oqelira-code.tgz}
git archive --format=tgz -o "$OUT" HEAD   # committed files only: no .env, no node_modules
echo "Built $OUT from $(git rev-parse --short HEAD)"
cat <<CMDS

export RG=flwn-ai-engine SUB="Azure subscription 1" LABEL=oqelira-runner ADMIN_IP=<your.public.ip>
export PUBKEY="\$(cat ~/.ssh/id_ed25519.pub)"

# 1. Review (read-only), then create:
az deployment group what-if -g \$RG --subscription "\$SUB" -f deploy/azure/runner/runner-vm.bicep \\
  -p sshPublicKey="\$PUBKEY" adminIp=\$ADMIN_IP dnsLabel=\$LABEL
az deployment group create  -g \$RG --subscription "\$SUB" -f deploy/azure/runner/runner-vm.bicep \\
  -p sshPublicKey="\$PUBKEY" adminIp=\$ADMIN_IP dnsLabel=\$LABEL

# 2. Wait for first boot (a few minutes), then copy the code and install:
HOST=\$LABEL.swedencentral.cloudapp.azure.com
ssh oqadmin@\$HOST 'cloud-init status --wait && test -f /var/lib/oqelira/.firstboot-done'
scp $OUT oqadmin@\$HOST:/tmp/oqelira-code.tgz
ssh oqadmin@\$HOST 'sudo /usr/local/sbin/oqelira-install.sh /tmp/oqelira-code.tgz'   # prints the pinned worker image

# 3. Read the runner token ONCE, interactively (do not log or paste it anywhere else):
ssh oqadmin@\$HOST 'sudo grep ^OQELIRA_RUNNER_TOKEN= /etc/oqelira/runner.env | cut -d= -f2-'
# Put it straight into the Container Apps secret (replace <api-app>; paste the value at the prompt):
#   az containerapp secret set -g \$RG -n <api-app> --secrets runner-token=<value>
#   az containerapp update -g \$RG -n <api-app> \\
#     --set-env-vars OQELIRA_RUNNER_URL=https://\$HOST OQELIRA_RUNNER_TOKEN=secretref:runner-token

# 4. Smoke test (expects 401 without the token):
curl -si -X POST https://\$HOST/execute -H 'content-type: application/json' -d '{}' | head -1
CMDS
