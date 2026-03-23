#!/usr/bin/env bash
# Two-terminal demo: IOU charge with auto-trustline and tx explorer links
#
# Terminal 1 (Server):
#   npx tsx demo/demo-server.ts --recipient <YOUR_ADDRESS> --currency '{"currency":"USD","issuer":"<ISSUER>"}' --amount 10
#
# Terminal 2 (Client):
#   npx tsx demo/demo-client.ts --seed <YOUR_SEED> --mode pull
#
# The client will auto-create a trustline if needed (autoTrustline: true).

set -euo pipefail

echo "=== IOU Charge Demo ==="
echo ""
echo "This demo requires two terminals, funded testnet wallets, and an IOU issuer."
echo ""
echo "1. Get testnet wallets at: https://faucet.altnet.rippletest.net/accounts"
echo ""
echo "2. Terminal 1 (Server):"
echo '   npx tsx demo/demo-server.ts --recipient <SERVER_ADDRESS> --currency '"'"'{"currency":"USD","issuer":"<ISSUER>"}'"'"' --amount 10'
echo ""
echo "3. Terminal 2 (Client):"
echo "   npx tsx demo/demo-client.ts --seed <CLIENT_SEED> --mode pull"
echo ""
echo "The client will auto-create a trustline for the IOU if missing."
