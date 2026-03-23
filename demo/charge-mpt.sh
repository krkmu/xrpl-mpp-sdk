#!/usr/bin/env bash
# Two-terminal demo: MPT charge with auto-authorize and tx explorer links
#
# Terminal 1 (Server):
#   npx tsx demo/demo-server.ts --recipient <YOUR_ADDRESS> --currency '{"mpt_issuance_id":"<MPT_ID>"}' --amount 100
#
# Terminal 2 (Client):
#   npx tsx demo/demo-client.ts --seed <YOUR_SEED> --mode pull
#
# The client will auto-authorize the MPT holding if needed (autoMPTAuthorize: true).

set -euo pipefail

echo "=== MPT Charge Demo ==="
echo ""
echo "This demo requires two terminals, funded testnet wallets, and an MPT issuance."
echo ""
echo "1. Get testnet wallets at: https://faucet.altnet.rippletest.net/accounts"
echo ""
echo "2. Terminal 1 (Server):"
echo '   npx tsx demo/demo-server.ts --recipient <SERVER_ADDRESS> --currency '"'"'{"mpt_issuance_id":"<MPT_ID>"}'"'"' --amount 100'
echo ""
echo "3. Terminal 2 (Client):"
echo "   npx tsx demo/demo-client.ts --seed <CLIENT_SEED> --mode pull"
echo ""
echo "The client will auto-authorize the MPT holding if missing."
