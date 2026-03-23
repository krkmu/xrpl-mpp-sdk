#!/usr/bin/env bash
# Two-terminal demo: XRP charge with tx explorer links
#
# Terminal 1 (Server):
#   npx tsx demo/demo-server.ts --recipient <YOUR_ADDRESS> --currency XRP --amount 1000000
#
# Terminal 2 (Client):
#   npx tsx demo/demo-client.ts --seed <YOUR_SEED> --mode pull
#
# This demo sends 1 XRP (1,000,000 drops) from the client to the server's recipient address.
# After payment, the server returns the protected resource and a Payment-Receipt header
# containing the tx hash. The client prints an XRPL testnet explorer link.

set -euo pipefail

echo "=== XRP Charge Demo ==="
echo ""
echo "This demo requires two terminals and funded testnet wallets."
echo ""
echo "1. Get testnet wallets at: https://faucet.altnet.rippletest.net/accounts"
echo ""
echo "2. Terminal 1 (Server):"
echo "   npx tsx demo/demo-server.ts --recipient <SERVER_ADDRESS> --currency XRP --amount 1000000"
echo ""
echo "3. Terminal 2 (Client):"
echo "   npx tsx demo/demo-client.ts --seed <CLIENT_SEED> --mode pull"
echo ""
echo "The client will:"
echo "  - Request the protected resource"
echo "  - Receive a 402 challenge"
echo "  - Sign a 1 XRP Payment transaction"
echo "  - Send the signed blob to the server"
echo "  - Server submits to testnet, returns the resource"
echo "  - Client prints the explorer link"
echo ""
echo "Explorer: https://testnet.xrpl.org/transactions/<TX_HASH>"
